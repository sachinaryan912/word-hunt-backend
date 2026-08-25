import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import { db } from './firebase';
import { getFriendUids, chunk } from './friends';
import { PlayerProfileDoc } from '../types';

export type LeaderboardPeriod = 'global' | 'daily' | 'weekly' | 'monthly';
export type LeaderboardScope = 'all' | 'friends';

export function dateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function weekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function monthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function periodDocKey(period: Exclude<LeaderboardPeriod, 'global'>, date: Date = new Date()): string {
  if (period === 'daily') return `daily_${dateKey(date)}`;
  if (period === 'weekly') return `weekly_${weekKey(date)}`;
  return `monthly_${monthKey(date)}`;
}

/** Adds `points` to a player's daily/weekly/monthly running totals. Fire-and-forget from callers. */
export async function incrementPeriodScore(uid: string, displayName: string, points: number): Promise<void> {
  if (points <= 0) return;
  const now = new Date();
  const keys: Exclude<LeaderboardPeriod, 'global'>[] = ['daily', 'weekly', 'monthly'];
  const batch = db.batch();
  for (const period of keys) {
    const ref = db.collection('leaderboardPeriods').doc(periodDocKey(period, now)).collection('entries').doc(uid);
    batch.set(ref, { uid, displayName, score: FieldValue.increment(points), updatedAt: Date.now() }, { merge: true });
  }
  await batch.commit();
}

/**
 * Patches the display name into the *current* daily/weekly/monthly period docs
 * (skipping any that don't exist yet, so this can't create a phantom zero-score
 * entry for a period the player hasn't scored in). incrementPeriodScore snapshots
 * displayName at score time and otherwise never refreshes it, so without this a
 * rename only shows up on periodic leaderboards once the player scores again.
 */
export async function syncDisplayNameAcrossPeriods(uid: string, displayName: string): Promise<void> {
  const now = new Date();
  const keys: Exclude<LeaderboardPeriod, 'global'>[] = ['daily', 'weekly', 'monthly'];
  const refs = keys.map((period) =>
    db.collection('leaderboardPeriods').doc(periodDocKey(period, now)).collection('entries').doc(uid),
  );
  const snaps = await Promise.all(refs.map((ref) => ref.get()));
  const batch = db.batch();
  let hasUpdate = false;
  snaps.forEach((snap, i) => {
    if (snap.exists) {
      batch.update(refs[i], { displayName });
      hasUpdate = true;
    }
  });
  if (hasUpdate) await batch.commit();
}

export interface LeaderboardEntryDto {
  rank: number;
  playerId: string;
  playerName: string;
  rating: number;
  wordsFound: number;
  isCurrentUser: boolean;
}

export interface LeaderboardResultDto {
  entries: LeaderboardEntryDto[];
  me: LeaderboardEntryDto;
}

async function globalAll(callerUid: string, limit: number): Promise<LeaderboardResultDto> {
  const topSnap = await db.collection('players').orderBy('rating', 'desc').limit(limit).get();
  const entries: LeaderboardEntryDto[] = topSnap.docs.map((doc, index) => {
    const p = doc.data() as PlayerProfileDoc;
    return {
      rank: index + 1,
      playerId: p.uid,
      playerName: p.displayName,
      rating: p.rating,
      wordsFound: p.wordsFoundTotal,
      isCurrentUser: p.uid === callerUid,
    };
  });

  const meSnap = await db.collection('players').doc(callerUid).get();
  const me = meSnap.data() as PlayerProfileDoc;
  const alreadyInTop = entries.find((e) => e.playerId === callerUid);
  let myRank = alreadyInTop?.rank ?? null;
  if (myRank === null) {
    const higherCount = await db.collection('players').where('rating', '>', me.rating).count().get();
    myRank = higherCount.data().count + 1;
  }

  return {
    entries,
    me: {
      rank: myRank,
      playerId: me.uid,
      playerName: me.displayName,
      rating: me.rating,
      wordsFound: me.wordsFoundTotal,
      isCurrentUser: true,
    },
  };
}

async function periodAll(period: Exclude<LeaderboardPeriod, 'global'>, callerUid: string, limit: number): Promise<LeaderboardResultDto> {
  const col = db.collection('leaderboardPeriods').doc(periodDocKey(period)).collection('entries');
  const topSnap = await col.orderBy('score', 'desc').limit(limit).get();
  const entries: LeaderboardEntryDto[] = topSnap.docs.map((doc, index) => {
    const d = doc.data();
    return {
      rank: index + 1,
      playerId: doc.id,
      playerName: d.displayName as string,
      rating: Math.round((d.score as number) ?? 0),
      wordsFound: 0,
      isCurrentUser: doc.id === callerUid,
    };
  });

  const myDoc = await col.doc(callerUid).get();
  const myScore = (myDoc.data()?.score as number) ?? 0;
  const myName = (myDoc.data()?.displayName as string) ?? 'You';
  const alreadyInTop = entries.find((e) => e.playerId === callerUid);
  let myRank = alreadyInTop?.rank ?? null;
  if (myRank === null) {
    const higherCount = await col.where('score', '>', myScore).count().get();
    myRank = higherCount.data().count + 1;
  }

  return {
    entries,
    me: {
      rank: myRank,
      playerId: callerUid,
      playerName: myName,
      rating: Math.round(myScore),
      wordsFound: 0,
      isCurrentUser: true,
    },
  };
}

async function friendsScoped(
  period: LeaderboardPeriod,
  callerUid: string,
  limit: number,
): Promise<LeaderboardResultDto> {
  const friendUids = await getFriendUids(callerUid);
  const uids = Array.from(new Set([callerUid, ...friendUids]));

  let raw: { uid: string; name: string; value: number; wordsFound: number }[] = [];

  if (period === 'global') {
    const docs = await Promise.all(
      chunk(uids, 30).map((batch) =>
        db.collection('players').where(FieldPath.documentId(), 'in', batch).get(),
      ),
    );
    raw = docs.flatMap((snap) =>
      snap.docs.map((d) => {
        const p = d.data() as PlayerProfileDoc;
        return { uid: p.uid, name: p.displayName, value: p.rating, wordsFound: p.wordsFoundTotal };
      }),
    );
  } else {
    const col = db.collection('leaderboardPeriods').doc(periodDocKey(period)).collection('entries');
    const docs = await Promise.all(uids.map((uid) => col.doc(uid).get()));
    raw = docs
      .filter((d) => d.exists)
      .map((d) => ({
        uid: d.id,
        name: (d.data()?.displayName as string) ?? 'Player',
        value: (d.data()?.score as number) ?? 0,
        wordsFound: 0,
      }));
    // Include friends with no activity yet at score 0 so the list isn't empty.
    for (const uid of uids) {
      if (!raw.some((r) => r.uid === uid)) raw.push({ uid, name: 'Player', value: 0, wordsFound: 0 });
    }
  }

  raw.sort((a, b) => b.value - a.value);
  const entries: LeaderboardEntryDto[] = raw.slice(0, limit).map((r, index) => ({
    rank: index + 1,
    playerId: r.uid,
    playerName: r.name,
    rating: Math.round(r.value),
    wordsFound: r.wordsFound,
    isCurrentUser: r.uid === callerUid,
  }));

  const myIndex = raw.findIndex((r) => r.uid === callerUid);
  const mine = raw[myIndex] ?? { uid: callerUid, name: 'You', value: 0, wordsFound: 0 };

  return {
    entries,
    me: {
      rank: myIndex === -1 ? raw.length + 1 : myIndex + 1,
      playerId: callerUid,
      playerName: mine.name,
      rating: Math.round(mine.value),
      wordsFound: mine.wordsFound,
      isCurrentUser: true,
    },
  };
}

export async function resolveLeaderboard(
  callerUid: string,
  period: LeaderboardPeriod,
  scope: LeaderboardScope,
  limit: number,
): Promise<LeaderboardResultDto> {
  if (scope === 'friends') return friendsScoped(period, callerUid, limit);
  if (period === 'global') return globalAll(callerUid, limit);
  return periodAll(period, callerUid, limit);
}

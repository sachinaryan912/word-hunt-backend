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

/**
 * Adds `points` to a player's daily/weekly/monthly running score totals, and stamps
 * their *current* rating (real ELO/MMR from `players/{uid}.rating`) onto the same
 * period docs. `rating` is always overwritten (not incremented) — the caller must
 * pass the player's just-read/just-updated rating so the period leaderboard's
 * ranking and displayed MMR stay identical to what the profile screen shows,
 * instead of drifting from a separately-accumulated period value.
 * Fire-and-forget from callers.
 */
export async function incrementPeriodScore(uid: string, displayName: string, points: number, rating: number): Promise<void> {
  const now = new Date();
  const keys: Exclude<LeaderboardPeriod, 'global'>[] = ['daily', 'weekly', 'monthly'];
  const batch = db.batch();
  for (const period of keys) {
    const ref = db.collection('leaderboardPeriods').doc(periodDocKey(period, now)).collection('entries').doc(uid);
    // rating is always stamped, even when points is 0 (e.g. a match lost 0-0 on score
    // still moves ELO), so the period leaderboard's MMR never lags a real rating change.
    const update: Record<string, unknown> = { uid, displayName, rating, updatedAt: Date.now() };
    if (points > 0) update.score = FieldValue.increment(points);
    batch.set(ref, update, { merge: true });
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
  avatar: string;
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
      avatar: p.avatar,
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
      avatar: me.avatar,
    },
  };
}

async function periodAll(period: Exclude<LeaderboardPeriod, 'global'>, callerUid: string, limit: number): Promise<LeaderboardResultDto> {
  const col = db.collection('leaderboardPeriods').doc(periodDocKey(period)).collection('entries');
  const topSnap = await col.orderBy('rating', 'desc').limit(limit).get();

  // Period entries don't carry avatar (only score/rating are denormalized there),
  // so batch-fetch the live profile for everyone shown to render their avatar —
  // this also doubles as the live-rating/name fallback for the caller below.
  const idsToFetch = Array.from(new Set([...topSnap.docs.map((d) => d.id), callerUid]));
  const playerSnaps = await Promise.all(
    chunk(idsToFetch, 30).map((batch) => db.collection('players').where(FieldPath.documentId(), 'in', batch).get()),
  );
  const playersByUid = new Map<string, PlayerProfileDoc>();
  playerSnaps.forEach((snap) => snap.docs.forEach((d) => playersByUid.set(d.id, d.data() as PlayerProfileDoc)));

  const entries: LeaderboardEntryDto[] = topSnap.docs.map((doc, index) => {
    const d = doc.data();
    return {
      rank: index + 1,
      playerId: doc.id,
      playerName: d.displayName as string,
      rating: (d.rating as number) ?? 0,
      wordsFound: 0,
      isCurrentUser: doc.id === callerUid,
      avatar: playersByUid.get(doc.id)?.avatar ?? '',
    };
  });

  const myDoc = await col.doc(callerUid).get();
  const myPlayer = playersByUid.get(callerUid);
  let myRating = myDoc.data()?.rating as number | undefined;
  let myName = myDoc.data()?.displayName as string | undefined;
  if (myRating === undefined) {
    // No activity yet this period — fall back to the live profile rating so
    // "me" here always matches the profile screen instead of showing 0.
    myRating = myPlayer?.rating ?? 0;
    myName = myPlayer?.displayName ?? myName;
  }
  myName = myName ?? 'You';
  const alreadyInTop = entries.find((e) => e.playerId === callerUid);
  let myRank = alreadyInTop?.rank ?? null;
  if (myRank === null) {
    const higherCount = await col.where('rating', '>', myRating).count().get();
    myRank = higherCount.data().count + 1;
  }

  return {
    entries,
    me: {
      rank: myRank,
      playerId: callerUid,
      playerName: myName,
      rating: myRating,
      wordsFound: 0,
      isCurrentUser: true,
      avatar: myPlayer?.avatar ?? '',
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

  // Live profiles give us avatar (never denormalized into period docs) plus a
  // rating/name fallback for anyone without period activity yet.
  const playerSnaps = await Promise.all(
    chunk(uids, 30).map((batch) => db.collection('players').where(FieldPath.documentId(), 'in', batch).get()),
  );
  const playersByUid = new Map<string, PlayerProfileDoc>();
  playerSnaps.forEach((snap) => snap.docs.forEach((d) => playersByUid.set(d.id, d.data() as PlayerProfileDoc)));

  let raw: { uid: string; name: string; value: number; wordsFound: number; avatar: string }[] = [];

  if (period === 'global') {
    raw = uids
      .map((uid) => playersByUid.get(uid))
      .filter((p): p is PlayerProfileDoc => p !== undefined)
      .map((p) => ({ uid: p.uid, name: p.displayName, value: p.rating, wordsFound: p.wordsFoundTotal, avatar: p.avatar }));
  } else {
    const col = db.collection('leaderboardPeriods').doc(periodDocKey(period)).collection('entries');
    const periodDocs = await Promise.all(uids.map((uid) => col.doc(uid).get()));
    raw = uids.map((uid, i) => {
      const d = periodDocs[i].data();
      const p = playersByUid.get(uid);
      return {
        uid,
        name: (d?.displayName as string) ?? p?.displayName ?? 'Player',
        // Friends with no period activity yet still have a real rating on their
        // profile — fall back to it so they don't show up as 0 MMR next to their
        // actual profile value.
        value: (d?.rating as number) ?? p?.rating ?? 0,
        wordsFound: 0,
        avatar: p?.avatar ?? '',
      };
    });
  }

  raw.sort((a, b) => b.value - a.value);
  const entries: LeaderboardEntryDto[] = raw.slice(0, limit).map((r, index) => ({
    rank: index + 1,
    playerId: r.uid,
    playerName: r.name,
    rating: Math.round(r.value),
    wordsFound: r.wordsFound,
    isCurrentUser: r.uid === callerUid,
    avatar: r.avatar,
  }));

  const myIndex = raw.findIndex((r) => r.uid === callerUid);
  const mine = raw[myIndex] ?? { uid: callerUid, name: 'You', value: 0, wordsFound: 0, avatar: '' };

  return {
    entries,
    me: {
      rank: myIndex === -1 ? raw.length + 1 : myIndex + 1,
      playerId: callerUid,
      playerName: mine.name,
      rating: Math.round(mine.value),
      wordsFound: mine.wordsFound,
      isCurrentUser: true,
      avatar: mine.avatar,
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

import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { db } from '../lib/firebase';
import { profileRef } from '../lib/profileStore';
import { generateBoard, tierForRating } from '../lib/boardGenerator';
import { ratingDelta } from '../lib/rating';
import { levelForXp, XP_MATCH_PARTICIPATION, XP_MATCH_WIN_BONUS } from '../lib/xp';
import { checkAndGrantAchievements } from '../lib/achievements';
import { incrementPeriodScore } from '../lib/periodicLeaderboard';
import { ActiveMatch, PlayerProfileDoc, QueueEntry } from '../types';
import { activeMatches, uidToMatch, uidToSocket } from './state';

const MATCH_DURATION_SECONDS = 90;

export function createMatch(io: Server, a: QueueEntry, b: QueueEntry): ActiveMatch {
  const matchId = randomUUID();
  const seed = matchId;
  const tier = tierForRating((a.rating + b.rating) / 2);
  const board = generateBoard(seed, tier);
  const startAt = Date.now();
  const endAt = startAt + MATCH_DURATION_SECONDS * 1000;

  const match: ActiveMatch = {
    matchId,
    board,
    players: [
      { uid: a.uid, displayName: a.displayName, rating: a.rating, score: 0, wordsFound: 0, connected: true, socketId: a.socketId, wasBehind: false, hadComebackWin: false },
      { uid: b.uid, displayName: b.displayName, rating: b.rating, score: 0, wordsFound: 0, connected: true, socketId: b.socketId, wasBehind: false, hadComebackWin: false },
    ],
    claimedWords: new Map(),
    startAt,
    endAt,
    durationSeconds: MATCH_DURATION_SECONDS,
    status: 'active',
    endTimer: null,
    disconnectTimers: new Map(),
  };

  activeMatches.set(matchId, match);
  uidToMatch.set(a.uid, matchId);
  uidToMatch.set(b.uid, matchId);

  match.endTimer = setTimeout(() => {
    void endMatch(io, matchId, 'timeout');
  }, MATCH_DURATION_SECONDS * 1000 + 500);

  db.collection('matches')
    .doc(matchId)
    .set({
      matchId,
      seed,
      generatorVersion: board.generatorVersion,
      playerIds: [a.uid, b.uid],
      players: match.players.map((p) => ({ uid: p.uid, displayName: p.displayName, ratingAtStart: p.rating })),
      status: 'active',
      startAt,
      endAt,
      durationSeconds: MATCH_DURATION_SECONDS,
    })
    .catch((err) => console.error('failed to persist match doc', err));

  for (const p of match.players) {
    const opponent = match.players.find((o) => o.uid !== p.uid)!;
    io.to(p.socketId!).emit('match:found', { matchId, opponent: { uid: opponent.uid, displayName: opponent.displayName, rating: opponent.rating } });
    io.to(p.socketId!).emit('match:start', {
      matchId,
      board: { rows: board.rows, cols: board.cols, grid: board.grid, targetWords: board.targetWords },
      you: { uid: p.uid, displayName: p.displayName, rating: p.rating },
      opponent: { uid: opponent.uid, displayName: opponent.displayName, rating: opponent.rating },
      startAt,
      endAt,
      durationSeconds: MATCH_DURATION_SECONDS,
    });
    io.sockets.sockets.get(p.socketId!)?.join(`match-${matchId}`);
  }

  return match;
}

type EndReason = 'completed' | 'timeout' | 'forfeit';

export async function endMatch(io: Server, matchId: string, reason: EndReason, forfeitingUid?: string) {
  const match = activeMatches.get(matchId);
  if (!match || match.status === 'ended') return;
  match.status = 'ended';

  if (match.endTimer) clearTimeout(match.endTimer);
  for (const timer of match.disconnectTimers.values()) clearTimeout(timer);

  const [p1, p2] = match.players;
  let winnerId: string | null;

  if (reason === 'forfeit' && forfeitingUid) {
    winnerId = match.players.find((p) => p.uid !== forfeitingUid)!.uid;
  } else if (p1.score !== p2.score) {
    winnerId = p1.score > p2.score ? p1.uid : p2.uid;
  } else if (p1.wordsFound !== p2.wordsFound) {
    winnerId = p1.wordsFound > p2.wordsFound ? p1.uid : p2.uid;
  } else {
    winnerId = null; // draw
  }

  const outcomeFor = (uid: string): 0 | 0.5 | 1 => {
    if (winnerId === null) return 0.5;
    return winnerId === uid ? 1 : 0;
  };

  const deltaP1 = ratingDelta(p1.rating, p2.rating, outcomeFor(p1.uid));
  const deltaP2 = ratingDelta(p2.rating, p1.rating, outcomeFor(p2.uid));
  const deltas: Record<string, number> = { [p1.uid]: deltaP1, [p2.uid]: deltaP2 };

  const updatedProfiles: Record<string, PlayerProfileDoc> = {};
  const newRatings = await db.runTransaction(async (tx) => {
    const refs = match.players.map((p) => profileRef(p.uid));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    const result: Record<string, number> = {};

    snaps.forEach((snap, i) => {
      const p = match.players[i];
      const profile = snap.data() as PlayerProfileDoc;
      const won = winnerId === p.uid;
      const lost = winnerId !== null && winnerId !== p.uid;
      const xpGain = XP_MATCH_PARTICIPATION + (won ? XP_MATCH_WIN_BONUS : 0);
      const newXp = profile.xp + xpGain;
      const newRating = Math.max(0, profile.rating + deltas[p.uid]);
      const newWinStreak = won ? profile.winStreak + 1 : lost ? 0 : profile.winStreak;

      const updates: Partial<PlayerProfileDoc> = {
        rating: newRating,
        xp: newXp,
        level: levelForXp(newXp),
        gamesPlayed: profile.gamesPlayed + 1,
        wins: profile.wins + (won ? 1 : 0),
        losses: profile.losses + (lost ? 1 : 0),
        bestScore: Math.max(profile.bestScore, p.score),
        winStreak: newWinStreak,
        bestStreak: Math.max(profile.bestStreak, newWinStreak),
        wordsFoundTotal: profile.wordsFoundTotal + p.wordsFound,
        updatedAt: Date.now(),
      };
      tx.update(refs[i], updates);
      result[p.uid] = newRating;
      updatedProfiles[p.uid] = { ...profile, ...updates };
    });

    return result;
  });

  await db
    .collection('matches')
    .doc(matchId)
    .update({
      status: 'ended',
      winnerId,
      reason,
      endedAt: Date.now(),
      scores: { [p1.uid]: p1.score, [p2.uid]: p2.score },
      ratingDeltas: deltas,
    })
    .catch((err) => console.error('failed to finalize match doc', err));

  for (const p of match.players) {
    const socketId = uidToSocket.get(p.uid);
    if (socketId) {
      io.to(socketId).emit('match:end', {
        matchId,
        winnerId,
        reason,
        scores: { [p1.uid]: p1.score, [p2.uid]: p2.score },
        ratingDeltas: deltas,
        newRatings,
      });
    }
  }

  // Fire-and-forget: periodic leaderboard totals and achievement grants never block the response to players.
  for (const p of match.players) {
    void incrementPeriodScore(p.uid, p.displayName, p.score);
    void (async () => {
      const profile = updatedProfiles[p.uid];
      const isWinner = winnerId === p.uid;
      let globalRank: number | null = null;
      if (isWinner) {
        const higher = await db.collection('players').where('rating', '>', profile.rating).count().get();
        globalRank = higher.data().count + 1;
      }
      await checkAndGrantAchievements(p.uid, profile, {
        hadComebackWin: isWinner && p.wasBehind,
        globalRank,
      });
    })();
  }

  activeMatches.delete(matchId);
  uidToMatch.delete(p1.uid);
  uidToMatch.delete(p2.uid);
}

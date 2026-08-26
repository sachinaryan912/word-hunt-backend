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
import { cancelBotPlay, scheduleBotPlay } from './botPlayer';

const MATCH_DURATION_SECONDS = 180;

/** Private room matches have no gameplay time limit. This is only a
 * background safety net so an abandoned-but-still-connected room match
 * (both sockets open, nobody ever finishes or disconnects) doesn't sit in
 * `activeMatches` forever — it never fires during normal play. */
const UNLIMITED_MATCH_SAFETY_MS = 2 * 60 * 60 * 1000;

export function createMatch(io: Server, a: QueueEntry, b: QueueEntry, options?: { unlimitedTime?: boolean }): ActiveMatch {
  const unlimitedTime = options?.unlimitedTime ?? false;
  const matchId = randomUUID();
  const seed = matchId;
  const tier = tierForRating((a.rating + b.rating) / 2);
  const board = generateBoard(seed, tier);
  const startAt = Date.now();
  const durationSeconds = unlimitedTime ? 0 : MATCH_DURATION_SECONDS;
  const timerMs = unlimitedTime ? UNLIMITED_MATCH_SAFETY_MS : MATCH_DURATION_SECONDS * 1000;
  const endAt = startAt + timerMs;

  const match: ActiveMatch = {
    matchId,
    board,
    players: [
      { uid: a.uid, displayName: a.displayName, rating: a.rating, score: 0, wordsFound: 0, connected: true, socketId: a.socketId, wasBehind: false, hadComebackWin: false, isBot: a.isBot },
      { uid: b.uid, displayName: b.displayName, rating: b.rating, score: 0, wordsFound: 0, connected: true, socketId: b.socketId, wasBehind: false, hadComebackWin: false, isBot: b.isBot },
    ],
    claimedWords: new Map(),
    startAt,
    endAt,
    durationSeconds,
    status: 'active',
    endTimer: null,
    disconnectTimers: new Map(),
  };

  activeMatches.set(matchId, match);
  uidToMatch.set(a.uid, matchId);
  uidToMatch.set(b.uid, matchId);

  match.endTimer = setTimeout(() => {
    void endMatch(io, matchId, 'timeout');
  }, timerMs + 500);

  const vsBot = match.players.some((p) => p.isBot);

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
      durationSeconds,
      vsBot,
    })
    .catch((err) => console.error('failed to persist match doc', err));

  for (const p of match.players) {
    if (p.isBot) continue;
    const opponent = match.players.find((o) => o.uid !== p.uid)!;
    io.to(p.socketId!).emit('match:found', { matchId, opponent: { uid: opponent.uid, displayName: opponent.displayName, rating: opponent.rating } });
    io.to(p.socketId!).emit('match:start', {
      matchId,
      board: { rows: board.rows, cols: board.cols, grid: board.grid, targetWords: board.targetWords },
      you: { uid: p.uid, displayName: p.displayName, rating: p.rating },
      opponent: { uid: opponent.uid, displayName: opponent.displayName, rating: opponent.rating },
      startAt,
      endAt,
      durationSeconds,
    });
    io.sockets.sockets.get(p.socketId!)?.join(`match-${matchId}`);
  }

  if (vsBot) scheduleBotPlay(io, match);

  return match;
}

type EndReason = 'completed' | 'timeout' | 'forfeit';

export async function endMatch(io: Server, matchId: string, reason: EndReason, forfeitingUid?: string) {
  const match = activeMatches.get(matchId);
  if (!match || match.status === 'ended') return;
  match.status = 'ended';
  cancelBotPlay(matchId);

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

  // Bots have no Firestore profile — only real players get their rating,
  // XP, and stats written (and only real players count for the periodic
  // leaderboard and achievements below).
  const realPlayers = match.players.filter((p) => !p.isBot);

  const updatedProfiles: Record<string, PlayerProfileDoc> = {};
  const newRatings = await db.runTransaction(async (tx) => {
    const refs = realPlayers.map((p) => profileRef(p.uid));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    const result: Record<string, number> = {};

    snaps.forEach((snap, i) => {
      const p = realPlayers[i];
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
  for (const p of realPlayers) {
    void incrementPeriodScore(p.uid, p.displayName, p.score, updatedProfiles[p.uid].rating);
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

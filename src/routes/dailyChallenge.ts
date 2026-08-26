import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getOrCreateProfile, profileRef } from '../lib/profileStore';
import { generateDailyBoard, todayDateKey, puzzleNumberFor } from '../lib/dailyChallenge';
import { levelForXp, xpBonusForDailyRank, XP_SOLO_COMPLETE_BASE, XP_SOLO_PER_WORD } from '../lib/xp';
import { checkAndGrantAchievements } from '../lib/achievements';
import { incrementPeriodScore } from '../lib/periodicLeaderboard';
import { PlayerProfileDoc } from '../types';

export const dailyChallengeRouter = Router();

dailyChallengeRouter.get('/', async (req: AuthedRequest, res) => {
  const dateKey = todayDateKey();
  const board = generateDailyBoard(dateKey);
  const uid = req.uid!;

  const [resultSnap, participantCountSnap] = await Promise.all([
    db.collection('dailyResults').doc(`${dateKey}_${uid}`).get(),
    db.collection('dailyResults').where('date', '==', dateKey).count().get(),
  ]);

  const personalBest = resultSnap.exists ? (resultSnap.data()!.score as number) : null;
  let globalRankToday: number | null = null;
  if (personalBest !== null) {
    const higher = await db
      .collection('dailyResults')
      .where('date', '==', dateKey)
      .where('score', '>', personalBest)
      .count()
      .get();
    globalRankToday = higher.data().count + 1;
  }

  res.json({
    date: dateKey,
    puzzleNumber: puzzleNumberFor(dateKey),
    board: { rows: board.rows, cols: board.cols, grid: board.grid, targetWords: board.targetWords },
    timeLimitSeconds: null,
    personalBest,
    globalRankToday,
    totalParticipantsToday: participantCountSnap.data().count,
  });
});

const completeSchema = z.object({
  wordsFound: z.number().int().min(0).max(20),
  // No gameplay time limit on the daily puzzle — this is just a generous sanity bound, not a countdown.
  timeSeconds: z.number().int().min(0).max(86400),
  hintsUsed: z.number().int().min(0).max(3),
});

dailyChallengeRouter.post('/complete', async (req: AuthedRequest, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const { wordsFound, timeSeconds, hintsUsed } = parsed.data;

  const dateKey = todayDateKey();
  const board = generateDailyBoard(dateKey);
  const targetWordCount = board.targetWords.length;

  if (wordsFound > targetWordCount) {
    res.status(400).json({ error: 'implausible_words_found' });
    return;
  }
  if (timeSeconds < wordsFound) {
    res.status(400).json({ error: 'implausible_duration' });
    return;
  }

  const avgWordLen = 6;
  const score = wordsFound * avgWordLen * 10;
  const accuracy = targetWordCount > 0 ? Math.round((wordsFound / targetWordCount) * 100) : 0;

  const uid = req.uid!;
  const profile = await getOrCreateProfile(uid);
  const resultRef = db.collection('dailyResults').doc(`${dateKey}_${uid}`);

  const { bestScore, isFirstCompletionToday } = await db.runTransaction(async (tx) => {
    const snap = await tx.get(resultRef);
    const existingScore = snap.exists ? (snap.data()!.score as number) : -1;
    const isFirst = !snap.exists;
    if (score > existingScore) {
      tx.set(resultRef, {
        date: dateKey,
        uid,
        displayName: profile.displayName,
        score,
        accuracy,
        timeSeconds,
        updatedAt: Date.now(),
      });
    }
    return { bestScore: Math.max(score, existingScore), isFirstCompletionToday: isFirst };
  });

  const higherThanBest = await db
    .collection('dailyResults')
    .where('date', '==', dateKey)
    .where('score', '>', bestScore)
    .count()
    .get();
  const rankToday = higherThanBest.data().count + 1;
  const xpBonus = xpBonusForDailyRank(rankToday);

  const profRef = profileRef(uid);
  const updatedProfile = await db.runTransaction(async (tx) => {
    const snap = await tx.get(profRef);
    const p = snap.data() as PlayerProfileDoc;
    const xpGain = XP_SOLO_COMPLETE_BASE + wordsFound * XP_SOLO_PER_WORD - hintsUsed * 2 + xpBonus;
    const newXp = Math.max(0, p.xp + Math.max(0, xpGain));
    const updates: Partial<PlayerProfileDoc> = {
      xp: newXp,
      level: levelForXp(newXp),
      wordsFoundTotal: p.wordsFoundTotal + wordsFound,
      dailyChallengesCompleted: isFirstCompletionToday ? p.dailyChallengesCompleted + 1 : p.dailyChallengesCompleted,
      bestDailyRank: p.bestDailyRank === null ? rankToday : Math.min(p.bestDailyRank, rankToday),
      updatedAt: Date.now(),
    };
    tx.update(profRef, updates);
    return { ...p, ...updates } as PlayerProfileDoc;
  });

  void incrementPeriodScore(uid, profile.displayName, score, updatedProfile.rating);
  void checkAndGrantAchievements(uid, updatedProfile, { lastSoloTimeSeconds: timeSeconds, lastSoloAccuracy: accuracy });

  res.json({ score, bestScore, accuracy, rankToday, xpBonus, profile: updatedProfile });
});

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getOrCreateProfile } from '../lib/profileStore';
import { tierForLevel, maxWordCountForTier } from '../lib/boardGenerator';
import { XP_SOLO_COMPLETE_BASE, XP_SOLO_PER_WORD, levelForXp, xpProgress } from '../lib/xp';
import { checkAndGrantAchievements } from '../lib/achievements';
import { incrementPeriodScore } from '../lib/periodicLeaderboard';
import { PlayerProfileDoc } from '../types';

export const soloRouter = Router();

const completeSchema = z.object({
  level: z.number().int().min(1).max(1000),
  wordsFound: z.number().int().min(0).max(20),
  targetWordCount: z.number().int().min(1).max(20),
  // No gameplay time limit on solo levels — this is just a generous sanity bound, not a countdown.
  timeSeconds: z.number().int().min(0).max(86400),
  hintsUsed: z.number().int().min(0).max(3),
});

soloRouter.post('/complete', async (req: AuthedRequest, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const { level, wordsFound, targetWordCount, timeSeconds, hintsUsed } = parsed.data;

  const tier = tierForLevel(level);
  const maxWords = maxWordCountForTier(tier);

  if (targetWordCount > maxWords) {
    res.status(400).json({ error: 'implausible_target_count' });
    return;
  }
  if (wordsFound > targetWordCount) {
    res.status(400).json({ error: 'implausible_words_found' });
    return;
  }
  if (timeSeconds < wordsFound) {
    // At least ~1 second per word found is the loosest plausible floor.
    res.status(400).json({ error: 'implausible_duration' });
    return;
  }

  const avgWordLen = 6;
  const score = wordsFound * avgWordLen * 10;
  const accuracy = targetWordCount > 0 ? Math.round((wordsFound / targetWordCount) * 100) : 0;

  const uid = req.uid!;
  await getOrCreateProfile(uid);
  const ref = db.collection('players').doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const profile = snap.data() as PlayerProfileDoc;

    const xpGain = XP_SOLO_COMPLETE_BASE + wordsFound * XP_SOLO_PER_WORD - hintsUsed * 2;
    const newXp = Math.max(0, profile.xp + Math.max(0, xpGain));
    const newLevel = levelForXp(newXp);

    const updated: Partial<PlayerProfileDoc> = {
      xp: newXp,
      level: newLevel,
      bestScore: Math.max(profile.bestScore, score),
      wordsFoundTotal: profile.wordsFoundTotal + wordsFound,
      soloLevelsCompleted:
        wordsFound === targetWordCount ? profile.soloLevelsCompleted + 1 : profile.soloLevelsCompleted,
      updatedAt: Date.now(),
    };

    tx.update(ref, updated);
    return { ...profile, ...updated } as PlayerProfileDoc;
  });

  void incrementPeriodScore(uid, result.displayName, score, result.rating);
  void checkAndGrantAchievements(uid, result, { lastSoloTimeSeconds: timeSeconds, lastSoloAccuracy: accuracy });

  res.json({
    score,
    accuracy,
    xpProgress: xpProgress(result.xp),
    profile: result,
  });
});

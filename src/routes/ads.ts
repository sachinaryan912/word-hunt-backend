import { Router } from 'express';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getOrCreateProfile, profileRef } from '../lib/profileStore';
import { levelForXp } from '../lib/xp';
import { todayDateKey } from '../lib/dailyChallenge';
import { PlayerProfileDoc } from '../types';

export const adsRouter = Router();

const REWARD_XP = 25;
const MAX_REWARDS_PER_DAY = 5;

adsRouter.post('/reward', async (req: AuthedRequest, res) => {
  const uid = req.uid!;
  await getOrCreateProfile(uid);
  const ref = profileRef(uid);
  const today = todayDateKey();

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const profile = snap.data() as PlayerProfileDoc;
    const claimedToday = profile.adRewardsDate === today ? profile.adRewardsClaimed : 0;

    if (claimedToday >= MAX_REWARDS_PER_DAY) {
      return { ok: false as const };
    }

    const newXp = profile.xp + REWARD_XP;
    const updates: Partial<PlayerProfileDoc> = {
      xp: newXp,
      level: levelForXp(newXp),
      adRewardsDate: today,
      adRewardsClaimed: claimedToday + 1,
      updatedAt: Date.now(),
    };
    tx.update(ref, updates);
    return { ok: true as const, profile: { ...profile, ...updates } as PlayerProfileDoc };
  });

  if (!result.ok) {
    res.status(429).json({ error: 'daily_reward_limit_reached' });
    return;
  }
  res.json({ xpAwarded: REWARD_XP, profile: result.profile });
});

import { Router } from 'express';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getOrCreateProfile, profileRef } from '../lib/profileStore';
import { levelForXp } from '../lib/xp';
import { todayDateKey } from '../lib/dailyChallenge';
import { PlayerProfileDoc } from '../types';

export const dailyGiftRouter = Router();

const DAILY_GIFT_XP = 10;

function statusFor(profile: PlayerProfileDoc, today: string) {
  const isToday = profile.dailyGiftDate === today;
  return {
    freeClaimed: isToday && profile.dailyGiftFreeClaimed,
    adClaimed: isToday && profile.dailyGiftAdClaimed,
  };
}

dailyGiftRouter.get('/status', async (req: AuthedRequest, res) => {
  const profile = await getOrCreateProfile(req.uid!);
  res.json(statusFor(profile, todayDateKey()));
});

dailyGiftRouter.post('/claim-free', async (req: AuthedRequest, res) => {
  const uid = req.uid!;
  await getOrCreateProfile(uid);
  const ref = profileRef(uid);
  const today = todayDateKey();

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const profile = snap.data() as PlayerProfileDoc;
    const { freeClaimed } = statusFor(profile, today);
    if (freeClaimed) return { ok: false as const };

    const newXp = profile.xp + DAILY_GIFT_XP;
    const updates: Partial<PlayerProfileDoc> = {
      xp: newXp,
      level: levelForXp(newXp),
      dailyGiftDate: today,
      dailyGiftFreeClaimed: true,
      // A new day resets the ad claim too.
      dailyGiftAdClaimed: profile.dailyGiftDate === today ? profile.dailyGiftAdClaimed : false,
      updatedAt: Date.now(),
    };
    tx.update(ref, updates);
    return { ok: true as const, profile: { ...profile, ...updates } as PlayerProfileDoc };
  });

  if (!result.ok) {
    res.status(409).json({ error: 'already_claimed' });
    return;
  }
  res.json({ xpAwarded: DAILY_GIFT_XP, profile: result.profile });
});

dailyGiftRouter.post('/claim-ad', async (req: AuthedRequest, res) => {
  const uid = req.uid!;
  await getOrCreateProfile(uid);
  const ref = profileRef(uid);
  const today = todayDateKey();

  // Unlimited — a player can watch as many rewarded ads as they like for
  // repeat XP once they've claimed today's free gift. `dailyGiftAdClaimed`
  // is kept only as an informational "watched at least one today" flag.
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const profile = snap.data() as PlayerProfileDoc;
    const { freeClaimed } = statusFor(profile, today);
    if (!freeClaimed) return { ok: false as const };

    const newXp = profile.xp + DAILY_GIFT_XP;
    const updates: Partial<PlayerProfileDoc> = {
      xp: newXp,
      level: levelForXp(newXp),
      dailyGiftAdClaimed: true,
      updatedAt: Date.now(),
    };
    tx.update(ref, updates);
    return { ok: true as const, profile: { ...profile, ...updates } as PlayerProfileDoc };
  });

  if (!result.ok) {
    res.status(409).json({ error: 'not_eligible' });
    return;
  }
  res.json({ xpAwarded: DAILY_GIFT_XP, profile: result.profile });
});

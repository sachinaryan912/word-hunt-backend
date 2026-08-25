import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getOrCreateProfile, profileRef } from '../lib/profileStore';
import { USERNAME_CHANGE_COST_XP } from '../lib/avatars';
import { syncDisplayNameAcrossPeriods } from '../lib/periodicLeaderboard';
import { PlayerProfileDoc } from '../types';

export const meRouter = Router();

meRouter.get('/', async (req: AuthedRequest, res) => {
  const profile = await getOrCreateProfile(req.uid!);
  res.json(profile);
});

const patchSchema = z.object({
  displayName: z.string().trim().min(1).max(24).optional(),
  fcmToken: z.string().min(1).optional(),
  notificationsEnabled: z.boolean().optional(),
});

meRouter.patch('/', async (req: AuthedRequest, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const uid = req.uid!;
  await getOrCreateProfile(uid);
  const ref = profileRef(uid);

  // Renaming spends XP (it's the same currency used for level progression, by design) — handle
  // it as an atomic charge-then-rename. Other fields in the same request ride along for free.
  if (parsed.data.displayName) {
    const newName = parsed.data.displayName;
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const profile = snap.data() as PlayerProfileDoc;
      if (profile.xp < USERNAME_CHANGE_COST_XP) {
        return { ok: false as const };
      }
      const updates: Partial<PlayerProfileDoc> = {
        displayName: newName,
        xp: profile.xp - USERNAME_CHANGE_COST_XP,
        updatedAt: Date.now(),
      };
      if (parsed.data.fcmToken) updates.fcmToken = parsed.data.fcmToken;
      if (parsed.data.notificationsEnabled !== undefined) updates.notificationsEnabled = parsed.data.notificationsEnabled;
      tx.update(ref, updates);
      return { ok: true as const, profile: { ...profile, ...updates } as PlayerProfileDoc };
    });

    if (!result.ok) {
      res.status(402).json({ error: 'insufficient_xp', cost: USERNAME_CHANGE_COST_XP });
      return;
    }
    void syncDisplayNameAcrossPeriods(uid, newName);
    res.json(result.profile);
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (parsed.data.fcmToken) updates.fcmToken = parsed.data.fcmToken;
  if (parsed.data.notificationsEnabled !== undefined) updates.notificationsEnabled = parsed.data.notificationsEnabled;
  await ref.update(updates);
  const snap = await ref.get();
  res.json(snap.data());
});

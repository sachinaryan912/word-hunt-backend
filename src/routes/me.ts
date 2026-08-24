import { Router } from 'express';
import { z } from 'zod';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getOrCreateProfile, profileRef } from '../lib/profileStore';

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
  await getOrCreateProfile(req.uid!);
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (parsed.data.displayName) updates.displayName = parsed.data.displayName;
  if (parsed.data.fcmToken) updates.fcmToken = parsed.data.fcmToken;
  if (parsed.data.notificationsEnabled !== undefined) updates.notificationsEnabled = parsed.data.notificationsEnabled;
  await profileRef(req.uid!).update(updates);
  const snap = await profileRef(req.uid!).get();
  res.json(snap.data());
});

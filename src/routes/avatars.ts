import { Router } from 'express';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getOrCreateProfile, profileRef } from '../lib/profileStore';
import { AVATAR_IDS, AVATAR_COST_XP, isValidAvatarId } from '../lib/avatars';
import { PlayerProfileDoc } from '../types';

export const avatarsRouter = Router();

avatarsRouter.get('/', async (req: AuthedRequest, res) => {
  const profile = await getOrCreateProfile(req.uid!);
  res.json({
    equipped: profile.avatar || null,
    avatars: AVATAR_IDS.map((id) => ({
      id,
      cost: AVATAR_COST_XP,
      unlocked: profile.unlockedAvatars.includes(id),
    })),
  });
});

avatarsRouter.post('/:id/unlock', async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  if (!isValidAvatarId(id)) {
    res.status(400).json({ error: 'invalid_avatar' });
    return;
  }
  const uid = req.uid!;
  await getOrCreateProfile(uid);
  const ref = profileRef(uid);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const profile = snap.data() as PlayerProfileDoc;
    if (profile.unlockedAvatars.includes(id)) {
      return { ok: true as const, alreadyOwned: true, profile };
    }
    if (profile.xp < AVATAR_COST_XP) {
      return { ok: false as const };
    }
    const newXp = profile.xp - AVATAR_COST_XP;
    const updates: Partial<PlayerProfileDoc> = {
      xp: newXp,
      unlockedAvatars: [...profile.unlockedAvatars, id],
      updatedAt: Date.now(),
    };
    tx.update(ref, updates);
    return { ok: true as const, alreadyOwned: false, profile: { ...profile, ...updates } as PlayerProfileDoc };
  });

  if (!result.ok) {
    res.status(402).json({ error: 'insufficient_xp', cost: AVATAR_COST_XP });
    return;
  }
  res.json({ unlocked: true, alreadyOwned: result.alreadyOwned, profile: result.profile });
});

avatarsRouter.post('/:id/equip', async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  if (!isValidAvatarId(id)) {
    res.status(400).json({ error: 'invalid_avatar' });
    return;
  }
  const uid = req.uid!;
  const profile = await getOrCreateProfile(uid);
  if (!profile.unlockedAvatars.includes(id)) {
    res.status(403).json({ error: 'not_unlocked' });
    return;
  }
  await profileRef(uid).update({ avatar: id, updatedAt: Date.now() });
  const snap = await profileRef(uid).get();
  res.json({ profile: snap.data() });
});

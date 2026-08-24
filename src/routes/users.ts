import { Router } from 'express';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';
import { PlayerProfileDoc } from '../types';

export const usersRouter = Router();

usersRouter.get('/search', async (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.json({ users: [] });
    return;
  }

  const snap = await db
    .collection('players')
    .orderBy('displayName')
    .where('displayName', '>=', q)
    .where('displayName', '<=', `${q}`)
    .limit(20)
    .get();

  const users = snap.docs
    .map((d) => d.data() as PlayerProfileDoc)
    .filter((p) => p.uid !== req.uid)
    .map((p) => ({ uid: p.uid, displayName: p.displayName, rating: p.rating }));

  res.json({ users });
});

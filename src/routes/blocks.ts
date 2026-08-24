import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';

export const blocksRouter = Router();

blocksRouter.get('/', async (req: AuthedRequest, res) => {
  const snap = await db.collection('players').doc(req.uid!).collection('blocked').get();
  res.json({ blocked: snap.docs.map((d) => d.id) });
});

const blockSchema = z.object({ targetUid: z.string().min(1) });

blocksRouter.post('/', async (req: AuthedRequest, res) => {
  const parsed = blockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  await db
    .collection('players')
    .doc(req.uid!)
    .collection('blocked')
    .doc(parsed.data.targetUid)
    .set({ blockedAt: Date.now() });
  res.json({ status: 'blocked' });
});

blocksRouter.delete('/:uid', async (req: AuthedRequest, res) => {
  await db.collection('players').doc(req.uid!).collection('blocked').doc(String(req.params.uid)).delete();
  res.json({ status: 'unblocked' });
});

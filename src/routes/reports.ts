import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';

export const reportsRouter = Router();

const reportSchema = z.object({
  targetUid: z.string().min(1),
  reason: z.string().min(1).max(200),
  matchId: z.string().optional(),
});

reportsRouter.post('/', async (req: AuthedRequest, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  await db.collection('reports').add({
    reporterUid: req.uid!,
    ...parsed.data,
    createdAt: Date.now(),
  });
  res.json({ status: 'received' });
});

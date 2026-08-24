import { Router } from 'express';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';

export const matchesRouter = Router();

matchesRouter.get('/:id', async (req: AuthedRequest, res) => {
  const matchId = String(req.params.id);
  const snap = await db.collection('matches').doc(matchId).get();
  if (!snap.exists) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const data = snap.data()!;
  const participantIds: string[] = data.playerIds ?? [];
  if (!participantIds.includes(req.uid!)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  res.json(data);
});

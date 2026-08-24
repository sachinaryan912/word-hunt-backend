import { Router } from 'express';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getAchievementsForUser } from '../lib/achievements';

export const achievementsRouter = Router();

achievementsRouter.get('/', async (req: AuthedRequest, res) => {
  const achievements = await getAchievementsForUser(req.uid!);
  res.json({ achievements });
});

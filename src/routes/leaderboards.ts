import { Router } from 'express';
import { AuthedRequest } from '../middleware/authMiddleware';
import { resolveLeaderboard, LeaderboardPeriod, LeaderboardScope } from '../lib/periodicLeaderboard';

export const leaderboardsRouter = Router();

const VALID_PERIODS: LeaderboardPeriod[] = ['global', 'daily', 'weekly', 'monthly'];
const VALID_SCOPES: LeaderboardScope[] = ['all', 'friends'];

leaderboardsRouter.get('/', async (req: AuthedRequest, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));
  const periodParam = String(req.query.period ?? 'global');
  const scopeParam = String(req.query.scope ?? 'all');

  const period = VALID_PERIODS.includes(periodParam as LeaderboardPeriod) ? (periodParam as LeaderboardPeriod) : 'global';
  const scope = VALID_SCOPES.includes(scopeParam as LeaderboardScope) ? (scopeParam as LeaderboardScope) : 'all';

  const result = await resolveLeaderboard(req.uid!, period, scope, limit);
  res.json(result);
});

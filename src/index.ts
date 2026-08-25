import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { env } from './config/env';
import { authMiddleware } from './middleware/authMiddleware';
import { apiRateLimit, mutationRateLimit } from './middleware/rateLimit';
import { meRouter } from './routes/me';
import { leaderboardsRouter } from './routes/leaderboards';
import { soloRouter } from './routes/solo';
import { matchesRouter } from './routes/matches';
import { dailyChallengeRouter } from './routes/dailyChallenge';
import { achievementsRouter } from './routes/achievements';
import { friendsRouter } from './routes/friends';
import { usersRouter } from './routes/users';
import { reportsRouter } from './routes/reports';
import { blocksRouter } from './routes/blocks';
import { adsRouter } from './routes/ads';
import { dailyGiftRouter } from './routes/dailyGift';
import { avatarsRouter } from './routes/avatars';
import { appConfigRouter } from './routes/appConfig';
import { setupSocket } from './socket/index';
import { startDailyReminderLoop } from './lib/dailyReminder';

const app = express();
app.use(helmet());
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json({ limit: '64kb' }));
app.use(apiRateLimit);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/v1/app-config', appConfigRouter);

app.use('/v1/me', authMiddleware, mutationRateLimit, meRouter);
app.use('/v1/leaderboards', authMiddleware, leaderboardsRouter);
app.use('/v1/solo', authMiddleware, mutationRateLimit, soloRouter);
app.use('/v1/matches', authMiddleware, matchesRouter);
app.use('/v1/daily-challenge', authMiddleware, mutationRateLimit, dailyChallengeRouter);
app.use('/v1/achievements', authMiddleware, achievementsRouter);
app.use('/v1/friends', authMiddleware, mutationRateLimit, friendsRouter);
app.use('/v1/users', authMiddleware, usersRouter);
app.use('/v1/reports', authMiddleware, mutationRateLimit, reportsRouter);
app.use('/v1/blocks', authMiddleware, mutationRateLimit, blocksRouter);
app.use('/v1/ads', authMiddleware, mutationRateLimit, adsRouter);
app.use('/v1/daily-gift', authMiddleware, mutationRateLimit, dailyGiftRouter);
app.use('/v1/avatars', authMiddleware, mutationRateLimit, avatarsRouter);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: env.corsOrigin } });
setupSocket(io);
startDailyReminderLoop();

server.listen(env.port, () => {
  console.log(`word-hunting-server listening on :${env.port}`);
});

import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { scoreForWord } from '../lib/scoring';
import { ActiveMatch, GridPos } from '../types';
import { activeMatches, uidToSocket } from './state';
import { endMatch } from './matchLifecycle';
import { SocketRateLimiter } from '../middleware/rateLimit';

const wordSelectSchema = z.object({
  matchId: z.string().min(1),
  path: z
    .array(z.object({ row: z.number().int().min(0).max(31), col: z.number().int().min(0).max(31) }))
    .min(1)
    .max(20),
});

const rateLimiter = new SocketRateLimiter(10, 1000);

function computeStraightLine(start: GridPos, end: GridPos): GridPos[] {
  const dRow = end.row - start.row;
  const dCol = end.col - start.col;
  if (dRow !== 0 && dCol !== 0 && Math.abs(dRow) !== Math.abs(dCol)) return [];
  const stepRow = dRow === 0 ? 0 : dRow / Math.abs(dRow);
  const stepCol = dCol === 0 ? 0 : dCol / Math.abs(dCol);
  const count = (dRow !== 0 ? Math.abs(dRow) : Math.abs(dCol)) + 1;
  const line: GridPos[] = [];
  for (let i = 0; i < count; i++) {
    line.push({ row: start.row + i * stepRow, col: start.col + i * stepCol });
  }
  return line;
}

function pathsEqual(a: GridPos[], b: GridPos[]): boolean {
  return a.length === b.length && a.every((p, i) => p.row === b[i].row && p.col === b[i].col);
}

export function broadcastToMatch(io: Server, match: ActiveMatch, event: string, payload: unknown) {
  for (const p of match.players) {
    const socketId = uidToSocket.get(p.uid) ?? p.socketId;
    if (socketId) io.to(socketId).emit(event, payload);
  }
}

export function registerGameplayHandlers(io: Server, socket: Socket, uid: string) {
  socket.on('word:select', (raw: unknown) => {
    if (!rateLimiter.allow(socket.id)) {
      socket.emit('word:rejected', { reason: 'rate_limited' });
      return;
    }

    const parsed = wordSelectSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit('word:rejected', { reason: 'malformed_payload' });
      return;
    }
    const { matchId, path } = parsed.data;

    const match = activeMatches.get(matchId);
    if (!match || match.status !== 'active') {
      socket.emit('word:rejected', { reason: 'match_not_active' });
      return;
    }
    if (!match.players.some((p) => p.uid === uid)) {
      socket.emit('word:rejected', { reason: 'not_a_participant' });
      return;
    }
    if (Date.now() >= match.endAt) {
      socket.emit('word:rejected', { reason: 'match_expired' });
      return;
    }

    const { board } = match;
    if (path.some((p) => p.row < 0 || p.row >= board.rows || p.col < 0 || p.col >= board.cols)) {
      socket.emit('word:rejected', { reason: 'out_of_bounds' });
      return;
    }
    const expectedLine = computeStraightLine(path[0], path[path.length - 1]);
    if (!pathsEqual(expectedLine, path)) {
      socket.emit('word:rejected', { reason: 'not_a_straight_line' });
      return;
    }

    const word = path.map((p) => board.grid[p.row][p.col]).join('');
    const reversed = word.split('').reverse().join('');
    const matchedTarget = board.targetWords.includes(word)
      ? word
      : board.targetWords.includes(reversed)
        ? reversed
        : null;

    if (!matchedTarget) {
      socket.emit('word:rejected', { reason: 'not_a_target_word' });
      return;
    }
    if (match.claimedWords.has(matchedTarget)) {
      socket.emit('word:rejected', { reason: 'already_claimed' });
      return;
    }

    const timeRemainingSec = Math.max(0, (match.endAt - Date.now()) / 1000);
    const score = scoreForWord(matchedTarget, timeRemainingSec, match.durationSeconds);

    match.claimedWords.set(matchedTarget, { claimedBy: uid, path, score });
    const player = match.players.find((p) => p.uid === uid)!;
    player.score += score;
    player.wordsFound += 1;

    for (const p of match.players) {
      const opponent = match.players.find((o) => o.uid !== p.uid)!;
      if (p.score < opponent.score) p.wasBehind = true;
    }

    const [p1, p2] = match.players;
    broadcastToMatch(io, match, 'word:claimed', {
      matchId,
      word: matchedTarget,
      path,
      claimedBy: uid,
      score,
      scores: { [p1.uid]: p1.score, [p2.uid]: p2.score },
    });

    if (match.claimedWords.size === board.targetWords.length) {
      void endMatch(io, matchId, 'completed');
    }
  });
}

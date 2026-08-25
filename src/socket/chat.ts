import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { SocketRateLimiter } from '../middleware/rateLimit';
import { activeMatches, uidToSocket } from './state';

// Small static placeholder filter — swap in a real moderation list/service later.
const BLOCKED_TERMS: string[] = [];

const chatSchema = z.object({
  channel: z.string().min(1).max(64),
  text: z.string().min(1).max(200),
});

const rateLimiter = new SocketRateLimiter(3, 2000);

function sanitize(text: string): string {
  let out = text;
  for (const term of BLOCKED_TERMS) {
    out = out.replace(new RegExp(term, 'gi'), '*'.repeat(term.length));
  }
  return out;
}

export function registerChatHandlers(io: Server, socket: Socket, uid: string, displayName: string) {
  socket.on('chat:send', (raw: unknown) => {
    if (!rateLimiter.allow(socket.id)) return;
    const parsed = chatSchema.safeParse(raw);
    if (!parsed.success) return;
    const { channel } = parsed.data;
    if (!channel.startsWith('match-')) return;

    // Authorize by match membership (uid), not Socket.IO room membership —
    // a room join only happens once, at match:start / match:rejoin, so a
    // socket that reconnected without an explicit rejoin (or joined the
    // channel under a now-stale socket id) would otherwise silently fail to
    // send or receive chat even though it's still a live match participant.
    const matchId = channel.slice('match-'.length);
    const match = activeMatches.get(matchId);
    if (!match || !match.players.some((p) => p.uid === uid)) return;

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: uid,
      senderName: displayName,
      text: sanitize(parsed.data.text),
      timestamp: Date.now(),
    };

    // Deliver directly by each participant's current live socket id, same
    // as gameplay broadcasts — this way chat keeps working across a
    // reconnect even in the instant before the client re-joins the room.
    for (const p of match.players) {
      if (p.isBot) continue;
      const socketId = uidToSocket.get(p.uid);
      if (socketId) io.to(socketId).emit('chat:message', message);
    }
  });
}

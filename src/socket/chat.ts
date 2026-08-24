import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { SocketRateLimiter } from '../middleware/rateLimit';

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

export function registerChatHandlers(socket: Socket, uid: string, displayName: string) {
  socket.on('chat:send', (raw: unknown) => {
    if (!rateLimiter.allow(socket.id)) return;
    const parsed = chatSchema.safeParse(raw);
    if (!parsed.success) return;

    // Only allow sending into a channel (match/room) this socket has actually joined.
    if (!socket.rooms.has(parsed.data.channel)) return;

    socket.to(parsed.data.channel).emit('chat:message', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: uid,
      senderName: displayName,
      text: sanitize(parsed.data.text),
      timestamp: Date.now(),
    });
    socket.emit('chat:message', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-self`,
      senderId: uid,
      senderName: displayName,
      text: sanitize(parsed.data.text),
      timestamp: Date.now(),
      isSelf: true,
    });
  });
}

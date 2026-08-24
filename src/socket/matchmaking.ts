import { Server, Socket } from 'socket.io';
import { getOrCreateProfile } from '../lib/profileStore';
import { getBlockedUids } from '../lib/blocks';
import { createMatch } from './matchLifecycle';
import { queue, removeFromQueue, uidToMatch } from './state';

const INITIAL_WINDOW = 200;
const WINDOW_EXPANSION_PER_5S = 50;

function ratingWindowFor(entry: { joinedAt: number }): number {
  const waitedSec = (Date.now() - entry.joinedAt) / 1000;
  return INITIAL_WINDOW + Math.floor(waitedSec / 5) * WINDOW_EXPANSION_PER_5S;
}

function isBlockedPair(a: { uid: string; blockedUids?: Set<string> }, b: { uid: string; blockedUids?: Set<string> }): boolean {
  return !!a.blockedUids?.has(b.uid) || !!b.blockedUids?.has(a.uid);
}

let matchmakingLoopStarted = false;

export function startMatchmakingLoop(io: Server) {
  if (matchmakingLoopStarted) return;
  matchmakingLoopStarted = true;

  setInterval(() => {
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i];
      const windowA = ratingWindowFor(a);
      for (let j = i + 1; j < queue.length; j++) {
        const b = queue[j];
        if (isBlockedPair(a, b)) continue;
        const windowB = ratingWindowFor(b);
        const diff = Math.abs(a.rating - b.rating);
        if (diff <= Math.max(windowA, windowB)) {
          queue.splice(j, 1);
          queue.splice(i, 1);
          createMatch(io, a, b);
          return; // restart scan next tick; indices are now stale
        }
      }
    }
  }, 1000);
}

export function registerMatchmakingHandlers(io: Server, socket: Socket, uid: string) {
  socket.on('matchmaking:join', async () => {
    if (uidToMatch.has(uid)) {
      socket.emit('error', { code: 'already_in_match' });
      return;
    }
    if (queue.some((e) => e.uid === uid)) {
      return; // Duplicate prevention: already queued
    }
    const [profile, blockedUids] = await Promise.all([getOrCreateProfile(uid), getBlockedUids(uid)]);
    queue.push({
      uid,
      displayName: profile.displayName,
      rating: profile.rating,
      socketId: socket.id,
      joinedAt: Date.now(),
      blockedUids,
    });
    socket.emit('matchmaking:queued', { rating: profile.rating });
  });

  socket.on('matchmaking:cancel', () => {
    removeFromQueue(uid);
    socket.emit('matchmaking:cancelled', {});
  });
}

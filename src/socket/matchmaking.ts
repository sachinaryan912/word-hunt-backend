import { Server, Socket } from 'socket.io';
import { getOrCreateProfile } from '../lib/profileStore';
import { getBlockedUids } from '../lib/blocks';
import { makeBotEntry } from '../lib/bots';
import { createMatch } from './matchLifecycle';
import { queue, removeFromQueue, uidToMatch } from './state';

const INITIAL_WINDOW = 200;
const WINDOW_EXPANSION_PER_5S = 50;

/** How long a player waits for a real opponent before getting a bot
 * instead. Keeps Quick Match from leaving a new/off-peak player searching
 * forever when nobody else happens to be queued at the same time. */
const BOT_FALLBACK_MS = 30_000;

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
        if (a.uid === b.uid) continue; // defense in depth; join is now de-duped below
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

    // Nobody real to pair with this tick — anyone who's waited long enough
    // gets a bot opponent instead of searching indefinitely.
    const now = Date.now();
    for (let i = queue.length - 1; i >= 0; i--) {
      const entry = queue[i];
      if (now - entry.joinedAt >= BOT_FALLBACK_MS) {
        queue.splice(i, 1);
        createMatch(io, entry, makeBotEntry(entry.rating));
      }
    }
  }, 1000);
}

// Reserves a uid against the async gap in 'matchmaking:join' below (the
// checks run again before the `await`, but a second rapid-fire join for the
// same uid — e.g. a client retry — could otherwise land in that gap, pass
// the same checks, and get queued twice, letting the pairing loop match a
// player against themself.
const pendingJoin = new Set<string>();

export function registerMatchmakingHandlers(io: Server, socket: Socket, uid: string) {
  socket.on('matchmaking:join', async () => {
    if (uidToMatch.has(uid)) {
      socket.emit('error', { code: 'already_in_match' });
      return;
    }
    if (queue.some((e) => e.uid === uid) || pendingJoin.has(uid)) {
      return; // Duplicate prevention: already queued or already joining
    }
    pendingJoin.add(uid);
    try {
      const [profile, blockedUids] = await Promise.all([getOrCreateProfile(uid), getBlockedUids(uid)]);
      // Re-check: cancel, disconnect, or a match could have landed while awaited above.
      if (uidToMatch.has(uid) || queue.some((e) => e.uid === uid)) return;
      queue.push({
        uid,
        displayName: profile.displayName,
        rating: profile.rating,
        socketId: socket.id,
        joinedAt: Date.now(),
        blockedUids,
      });
      socket.emit('matchmaking:queued', { rating: profile.rating });
    } finally {
      pendingJoin.delete(uid);
    }
  });

  socket.on('matchmaking:cancel', () => {
    removeFromQueue(uid);
    socket.emit('matchmaking:cancelled', {});
  });
}

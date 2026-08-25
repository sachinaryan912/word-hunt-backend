import { ActiveMatch, QueueEntry, RoomState } from '../types';

/** In-memory matchmaking queue. One entry per waiting uid (Duplicate prevention enforced by callers). */
export const queue: QueueEntry[] = [];

/** matchId -> live match state. */
export const activeMatches = new Map<string, ActiveMatch>();

/** uid -> matchId, for players currently in an active match. */
export const uidToMatch = new Map<string, string>();

/** uid -> current live socket id (latest connection wins). */
export const uidToSocket = new Map<string, string>();

/** socket id -> uid, for quick lookup on disconnect. */
export const socketToUid = new Map<string, string>();

export function removeFromQueue(uid: string) {
  const idx = queue.findIndex((e) => e.uid === uid);
  if (idx !== -1) queue.splice(idx, 1);
}

/** room code -> live lobby state. */
export const rooms = new Map<string, RoomState>();

/** uid -> room code, for players currently in a lobby. */
export const uidToRoom = new Map<string, string>();

/** uid -> pending grace-period timer, for a player who just disconnected
 * from a room lobby (not yet in a match). Cancelled by `room:sync` if they
 * reconnect in time — mirrors the active-match disconnect grace period so a
 * brief network blip doesn't instantly tear down the lobby. */
export const roomDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

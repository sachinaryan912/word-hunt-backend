import { Server, Socket } from 'socket.io';
import { getOrCreateProfile } from '../lib/profileStore';
import { sendPushToUser } from '../lib/notifications';
import { EXTRA_ROOM_COST_XP, reserveRoomCreation } from '../lib/roomLimits';
import { createMatch } from './matchLifecycle';
import { rooms, roomDisconnectTimers, uidToRoom } from './state';
import { RoomState } from '../types';

const ROOM_EXPIRY_MS = 10 * 60 * 1000;

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function clearDisconnectTimer(uid: string) {
  const timer = roomDisconnectTimers.get(uid);
  if (timer) {
    clearTimeout(timer);
    roomDisconnectTimers.delete(uid);
  }
}

export function roomPayload(room: RoomState) {
  return {
    code: room.code,
    host: { uid: room.hostUid, displayName: room.hostDisplayName, rating: room.hostRating, ready: room.hostReady },
    guest: room.guestUid
      ? { uid: room.guestUid, displayName: room.guestDisplayName, rating: room.guestRating, ready: room.guestReady }
      : null,
  };
}

function broadcastRoomUpdate(io: Server, room: RoomState) {
  io.to(`room-${room.code}`).emit('room:update', roomPayload(room));
}

export function closeRoom(io: Server, code: string, reason: string) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.expireTimer) clearTimeout(room.expireTimer);
  io.to(`room-${code}`).emit('room:closed', { code, reason });
  clearDisconnectTimer(room.hostUid);
  uidToRoom.delete(room.hostUid);
  if (room.guestUid) {
    clearDisconnectTimer(room.guestUid);
    uidToRoom.delete(room.guestUid);
  }
  rooms.delete(code);
}

function scheduleExpiry(io: Server, room: RoomState) {
  if (room.expireTimer) clearTimeout(room.expireTimer);
  room.expireTimer = setTimeout(() => closeRoom(io, room.code, 'expired'), ROOM_EXPIRY_MS);
}

// Reserves a uid across the async gaps in 'room:create' below. Without this,
// two rapid room:create calls from the same host (double-tap, client retry)
// both pass the initial uidToRoom check, both run reserveRoomCreation (each
// charging/decrementing the daily free-room count independently), and the
// second rooms.set/uidToRoom.set silently orphans the first room until its
// 10-minute expiry.
const pendingRoomCreate = new Set<string>();

export function registerRoomHandlers(io: Server, socket: Socket, uid: string) {
  socket.on('room:create', async () => {
    if (uidToRoom.has(uid) || pendingRoomCreate.has(uid)) {
      socket.emit('error', { code: 'already_in_room' });
      return;
    }
    pendingRoomCreate.add(uid);
    try {
      const profile = await getOrCreateProfile(uid);

      const reservation = await reserveRoomCreation(uid);
      if (!reservation.ok) {
        socket.emit('error', { code: 'insufficient_xp_for_room', xpNeeded: EXTRA_ROOM_COST_XP });
        return;
      }
      if (reservation.xpCharged > 0) {
        socket.emit('room:xp_charged', { amount: reservation.xpCharged });
      }

      let code = generateCode();
      while (rooms.has(code)) code = generateCode();

      const room: RoomState = {
        code,
        hostUid: uid,
        hostDisplayName: profile.displayName,
        hostRating: profile.rating,
        hostSocketId: socket.id,
        hostReady: false,
        guestUid: null,
        guestDisplayName: null,
        guestRating: null,
        guestSocketId: null,
        guestReady: false,
        createdAt: Date.now(),
        expireTimer: null,
      };
      rooms.set(code, room);
      uidToRoom.set(uid, code);
      socket.join(`room-${code}`);
      scheduleExpiry(io, room);
      socket.emit('room:created', { code });
      broadcastRoomUpdate(io, room);
    } finally {
      pendingRoomCreate.delete(uid);
    }
  });

  socket.on('room:join', async (data: { code?: string }) => {
    const code = data?.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) {
      socket.emit('error', { code: 'room_not_found' });
      return;
    }
    if (room.guestUid && room.guestUid !== uid) {
      socket.emit('error', { code: 'room_full' });
      return;
    }
    if (uidToRoom.has(uid) && uidToRoom.get(uid) !== code) {
      socket.emit('error', { code: 'already_in_room' });
      return;
    }

    const profile = await getOrCreateProfile(uid);

    // Re-check synchronously (no await between here and the write below): a
    // second room:join for this code could have landed and filled the guest
    // slot while we awaited the profile fetch above.
    if (!rooms.has(code)) {
      socket.emit('error', { code: 'room_not_found' });
      return;
    }
    if (room.guestUid && room.guestUid !== uid) {
      socket.emit('error', { code: 'room_full' });
      return;
    }

    room.guestUid = uid;
    room.guestDisplayName = profile.displayName;
    room.guestRating = profile.rating;
    room.guestSocketId = socket.id;
    uidToRoom.set(uid, code);
    socket.join(`room-${code}`);
    scheduleExpiry(io, room);
    broadcastRoomUpdate(io, room);
  });

  socket.on('room:ready', (data: { code?: string; ready?: boolean }) => {
    const room = rooms.get(data?.code ?? '');
    if (!room) return;
    if (room.hostUid === uid) room.hostReady = !!data.ready;
    else if (room.guestUid === uid) room.guestReady = !!data.ready;
    else return;
    broadcastRoomUpdate(io, room);
  });

  socket.on('room:leave', (data: { code?: string }) => {
    const code = data?.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    socket.leave(`room-${code}`);
    clearDisconnectTimer(uid);
    if (room.hostUid === uid) {
      closeRoom(io, code, 'host_left');
      return;
    }
    if (room.guestUid === uid) {
      room.guestUid = null;
      room.guestDisplayName = null;
      room.guestRating = null;
      room.guestSocketId = null;
      room.guestReady = false;
      uidToRoom.delete(uid);
      broadcastRoomUpdate(io, room);
    }
  });

  socket.on('room:start', (data: { code?: string }) => {
    const room = rooms.get(data?.code ?? '');
    if (!room) {
      socket.emit('error', { code: 'room_not_found' });
      return;
    }
    if (room.hostUid !== uid) {
      socket.emit('error', { code: 'not_host' });
      return;
    }
    if (!room.guestUid || !room.hostReady || !room.guestReady) {
      socket.emit('error', { code: 'not_ready' });
      return;
    }

    if (room.expireTimer) clearTimeout(room.expireTimer);
    clearDisconnectTimer(room.hostUid);
    clearDisconnectTimer(room.guestUid);
    uidToRoom.delete(room.hostUid);
    uidToRoom.delete(room.guestUid);
    rooms.delete(room.code);

    createMatch(
      io,
      { uid: room.hostUid, displayName: room.hostDisplayName, rating: room.hostRating, socketId: room.hostSocketId, joinedAt: Date.now() },
      { uid: room.guestUid, displayName: room.guestDisplayName!, rating: room.guestRating!, socketId: room.guestSocketId!, joinedAt: Date.now() },
      { unlimitedTime: true },
    );
  });

  socket.on('room:invite', (data: { code?: string; friendUid?: string }) => {
    const { code, friendUid } = data ?? {};
    if (!code || !friendUid) return;
    const room = rooms.get(code);
    if (!room || room.hostUid !== uid) return;
    void sendPushToUser(friendUid, 'Room invite', `${room.hostDisplayName} invited you to a private match — code ${code}`, {
      type: 'room_invite',
      code,
    });
  });

  // Called by the client right after a socket reconnect (e.g. a brief
  // network drop) so a player who's still within their disconnect grace
  // period picks back up in the same lobby instead of it going stale or
  // being torn down.
  socket.on('room:sync', () => {
    const code = uidToRoom.get(uid);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    clearDisconnectTimer(uid);
    if (room.hostUid === uid) room.hostSocketId = socket.id;
    else if (room.guestUid === uid) room.guestSocketId = socket.id;
    socket.join(`room-${code}`);
    io.to(`room-${code}`).emit('room:player_reconnected', { code, uid });
    broadcastRoomUpdate(io, room);
  });
}

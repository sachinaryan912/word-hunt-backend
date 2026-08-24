import { Server, Socket } from 'socket.io';
import { getOrCreateProfile } from '../lib/profileStore';
import { sendPushToUser } from '../lib/notifications';
import { reserveRoomCreation } from '../lib/roomLimits';
import { createMatch } from './matchLifecycle';
import { rooms, uidToRoom } from './state';
import { RoomState } from '../types';

const ROOM_EXPIRY_MS = 10 * 60 * 1000;

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function roomPayload(room: RoomState) {
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
  uidToRoom.delete(room.hostUid);
  if (room.guestUid) uidToRoom.delete(room.guestUid);
  rooms.delete(code);
}

function scheduleExpiry(io: Server, room: RoomState) {
  if (room.expireTimer) clearTimeout(room.expireTimer);
  room.expireTimer = setTimeout(() => closeRoom(io, room.code, 'expired'), ROOM_EXPIRY_MS);
}

export function registerRoomHandlers(io: Server, socket: Socket, uid: string) {
  socket.on('room:create', async () => {
    if (uidToRoom.has(uid)) {
      socket.emit('error', { code: 'already_in_room' });
      return;
    }
    const profile = await getOrCreateProfile(uid);

    const reservation = await reserveRoomCreation(uid);
    if (!reservation.ok) {
      socket.emit('error', { code: 'insufficient_xp_for_room', xpNeeded: 5 });
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
    uidToRoom.delete(room.hostUid);
    uidToRoom.delete(room.guestUid);
    rooms.delete(room.code);

    createMatch(
      io,
      { uid: room.hostUid, displayName: room.hostDisplayName, rating: room.hostRating, socketId: room.hostSocketId, joinedAt: Date.now() },
      { uid: room.guestUid, displayName: room.guestDisplayName!, rating: room.guestRating!, socketId: room.guestSocketId!, joinedAt: Date.now() },
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
}

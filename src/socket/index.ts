import { Server } from 'socket.io';
import { verifySocketToken } from '../middleware/authMiddleware';
import { getOrCreateProfile } from '../lib/profileStore';
import { registerMatchmakingHandlers, startMatchmakingLoop } from './matchmaking';
import { registerGameplayHandlers } from './gameplay';
import { registerDisconnectHandlers } from './disconnect';
import { registerRoomHandlers } from './rooms';
import { registerChatHandlers } from './chat';
import { socketToUid, uidToSocket } from './state';

export function setupSocket(io: Server) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const uid = await verifySocketToken(token);
    if (!uid) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.uid = uid;
    next();
  });

  io.on('connection', async (socket) => {
    const uid = socket.data.uid as string;
    const profile = await getOrCreateProfile(uid);

    uidToSocket.set(uid, socket.id);
    socketToUid.set(socket.id, uid);

    registerMatchmakingHandlers(io, socket, uid);
    registerGameplayHandlers(io, socket, uid);
    registerDisconnectHandlers(io, socket, uid);
    registerRoomHandlers(io, socket, uid);
    registerChatHandlers(socket, uid, profile.displayName);
  });

  startMatchmakingLoop(io);
}

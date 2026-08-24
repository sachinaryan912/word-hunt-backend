import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { activeMatches, removeFromQueue, rooms, socketToUid, uidToMatch, uidToRoom, uidToSocket } from './state';
import { broadcastToMatch } from './gameplay';
import { endMatch } from './matchLifecycle';
import { closeRoom } from './rooms';

const GRACE_PERIOD_MS = 20_000;
const rejoinSchema = z.object({ matchId: z.string().min(1) });

export function registerDisconnectHandlers(io: Server, socket: Socket, uid: string) {
  socket.on('match:rejoin', (raw: unknown) => {
    const parsed = rejoinSchema.safeParse(raw);
    if (!parsed.success) return;
    const match = activeMatches.get(parsed.data.matchId);
    if (!match || match.status !== 'active') {
      socket.emit('error', { code: 'match_not_found' });
      return;
    }
    const player = match.players.find((p) => p.uid === uid);
    if (!player) {
      socket.emit('error', { code: 'not_a_participant' });
      return;
    }

    const timer = match.disconnectTimers.get(uid);
    if (timer) {
      clearTimeout(timer);
      match.disconnectTimers.delete(uid);
    }
    player.connected = true;
    player.socketId = socket.id;
    uidToSocket.set(uid, socket.id);
    socket.join(`match-${match.matchId}`);

    const opponent = match.players.find((p) => p.uid !== uid)!;
    const [p1, p2] = match.players;
    socket.emit('match:state', {
      matchId: match.matchId,
      board: { rows: match.board.rows, cols: match.board.cols, grid: match.board.grid, targetWords: match.board.targetWords },
      claimedWords: Array.from(match.claimedWords.entries()).map(([word, c]) => ({ word, ...c })),
      scores: { [p1.uid]: p1.score, [p2.uid]: p2.score },
      startAt: match.startAt,
      endAt: match.endAt,
      durationSeconds: match.durationSeconds,
      opponentConnected: opponent.connected,
    });
    broadcastToMatch(io, match, 'player:reconnected', { matchId: match.matchId, uid });
  });

  socket.on('disconnect', () => {
    socketToUid.delete(socket.id);
    if (uidToSocket.get(uid) !== socket.id) {
      // A newer connection for this uid already replaced this socket; nothing to clean up.
      return;
    }
    uidToSocket.delete(uid);
    removeFromQueue(uid);

    const roomCode = uidToRoom.get(uid);
    if (roomCode) {
      const room = rooms.get(roomCode);
      if (room?.hostUid === uid) {
        closeRoom(io, roomCode, 'host_left');
      } else if (room?.guestUid === uid) {
        room.guestUid = null;
        room.guestDisplayName = null;
        room.guestRating = null;
        room.guestSocketId = null;
        room.guestReady = false;
        uidToRoom.delete(uid);
        io.to(`room-${roomCode}`).emit('room:update', {
          code: room.code,
          host: { uid: room.hostUid, displayName: room.hostDisplayName, rating: room.hostRating, ready: room.hostReady },
          guest: null,
        });
      }
    }

    const matchId = uidToMatch.get(uid);
    if (!matchId) return;
    const match = activeMatches.get(matchId);
    if (!match || match.status !== 'active') return;

    const player = match.players.find((p) => p.uid === uid);
    if (!player) return;
    player.connected = false;

    broadcastToMatch(io, match, 'player:disconnected', { matchId, uid });

    const timer = setTimeout(() => {
      void endMatch(io, matchId, 'forfeit', uid);
    }, GRACE_PERIOD_MS);
    match.disconnectTimers.set(uid, timer);
  });
}

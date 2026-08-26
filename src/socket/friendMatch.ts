import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { db } from '../lib/firebase';
import { getOrCreateProfile } from '../lib/profileStore';
import { getBlockedUids } from '../lib/blocks';
import { sendPushToUser } from '../lib/notifications';
import { createMatch } from './matchLifecycle';
import { friendInvites, incomingInviteByUid, outgoingInviteByUid, queue, uidToMatch, uidToRoom, uidToSocket } from './state';

/** How long the invitee has to accept before the invite auto-expires. Generous
 * enough to cover a push-notification tap (recipient's app was backgrounded
 * or closed), while still short enough that the inviter isn't left waiting
 * indefinitely for a "right now" real-time match. */
const INVITE_TIMEOUT_MS = 60_000;

function isBusy(uid: string): boolean {
  return uidToMatch.has(uid) || uidToRoom.has(uid) || queue.some((e) => e.uid === uid);
}

async function areFriends(a: string, b: string): Promise<boolean> {
  const doc = await db.collection('players').doc(a).collection('friends').doc(b).get();
  return doc.exists;
}

function clearInvite(inviteId: string) {
  const invite = friendInvites.get(inviteId);
  if (!invite) return;
  clearTimeout(invite.timeoutTimer);
  friendInvites.delete(inviteId);
  if (outgoingInviteByUid.get(invite.fromUid) === inviteId) outgoingInviteByUid.delete(invite.fromUid);
  if (incomingInviteByUid.get(invite.toUid) === inviteId) incomingInviteByUid.delete(invite.toUid);
}

/** Called on disconnect for either side of a pending invite. */
export function cancelFriendInvitesFor(io: Server, uid: string) {
  const outgoingId = outgoingInviteByUid.get(uid);
  if (outgoingId) {
    const invite = friendInvites.get(outgoingId);
    clearInvite(outgoingId);
    if (invite) {
      const toSocket = uidToSocket.get(invite.toUid);
      if (toSocket) io.to(toSocket).emit('friend_match:cancelled', { inviteId: outgoingId });
    }
  }
  const incomingId = incomingInviteByUid.get(uid);
  if (incomingId) {
    const invite = friendInvites.get(incomingId);
    clearInvite(incomingId);
    if (invite) {
      const fromSocket = uidToSocket.get(invite.fromUid);
      if (fromSocket) io.to(fromSocket).emit('friend_match:accept_failed', { inviteId: incomingId, code: 'friend_unavailable' });
    }
  }
}

export function registerFriendMatchHandlers(io: Server, socket: Socket, uid: string) {
  socket.on('friend_match:invite', async (data: { toUid?: string }) => {
    const toUid = data?.toUid;
    if (!toUid || toUid === uid) return;

    if (isBusy(uid)) {
      socket.emit('friend_match:error', { code: 'already_busy' });
      return;
    }
    if (outgoingInviteByUid.has(uid)) {
      socket.emit('friend_match:error', { code: 'invite_already_pending' });
      return;
    }
    if (isBusy(toUid) || incomingInviteByUid.has(toUid)) {
      socket.emit('friend_match:error', { code: 'friend_busy' });
      return;
    }
    if (!(await areFriends(uid, toUid))) {
      socket.emit('friend_match:error', { code: 'not_friends' });
      return;
    }
    const [blockedByMe, blockedByThem] = await Promise.all([getBlockedUids(uid), getBlockedUids(toUid)]);
    if (blockedByMe.has(toUid) || blockedByThem.has(uid)) {
      socket.emit('friend_match:error', { code: 'blocked' });
      return;
    }

    const fromProfile = await getOrCreateProfile(uid);
    const inviteId = randomUUID();
    const timeoutTimer = setTimeout(() => {
      clearInvite(inviteId);
      socket.emit('friend_match:expired', { inviteId });
      const toSocket = uidToSocket.get(toUid);
      if (toSocket) io.to(toSocket).emit('friend_match:expired', { inviteId });
    }, INVITE_TIMEOUT_MS);

    friendInvites.set(inviteId, {
      inviteId,
      fromUid: uid,
      fromDisplayName: fromProfile.displayName,
      fromRating: fromProfile.rating,
      toUid,
      createdAt: Date.now(),
      timeoutTimer,
    });
    outgoingInviteByUid.set(uid, inviteId);
    incomingInviteByUid.set(toUid, inviteId);

    socket.emit('friend_match:invite_sent', { inviteId, toUid });

    const toSocket = uidToSocket.get(toUid);
    if (toSocket) {
      io.to(toSocket).emit('friend_match:invite', { inviteId, fromUid: uid, fromDisplayName: fromProfile.displayName });
    }
    void sendPushToUser(toUid, 'Friend match invite', `${fromProfile.displayName} wants to play a match with you`, {
      type: 'friend_match_invite',
      inviteId,
      fromUid: uid,
      fromDisplayName: fromProfile.displayName,
    });
  });

  socket.on('friend_match:cancel', (data: { inviteId?: string }) => {
    const inviteId = data?.inviteId;
    if (!inviteId) return;
    const invite = friendInvites.get(inviteId);
    if (!invite || invite.fromUid !== uid) return;
    clearInvite(inviteId);
    const toSocket = uidToSocket.get(invite.toUid);
    if (toSocket) io.to(toSocket).emit('friend_match:cancelled', { inviteId });
  });

  socket.on('friend_match:decline', (data: { inviteId?: string }) => {
    const inviteId = data?.inviteId;
    if (!inviteId) return;
    const invite = friendInvites.get(inviteId);
    if (!invite || invite.toUid !== uid) return;
    clearInvite(inviteId);
    const fromSocket = uidToSocket.get(invite.fromUid);
    if (fromSocket) io.to(fromSocket).emit('friend_match:declined', { inviteId });
  });

  socket.on('friend_match:accept', async (data: { inviteId?: string }) => {
    const inviteId = data?.inviteId;
    if (!inviteId) return;
    const invite = friendInvites.get(inviteId);
    if (!invite || invite.toUid !== uid) {
      socket.emit('friend_match:accept_failed', { inviteId, code: 'invite_not_found' });
      return;
    }
    clearInvite(inviteId);

    const fromSocketId = uidToSocket.get(invite.fromUid);
    if (!fromSocketId || isBusy(invite.fromUid)) {
      socket.emit('friend_match:accept_failed', { inviteId, code: 'friend_unavailable' });
      return;
    }
    if (isBusy(uid)) {
      const fromSocket = uidToSocket.get(invite.fromUid);
      if (fromSocket) io.to(fromSocket).emit('friend_match:accept_failed', { inviteId, code: 'friend_unavailable' });
      socket.emit('friend_match:accept_failed', { inviteId, code: 'already_busy' });
      return;
    }

    const accepterProfile = await getOrCreateProfile(uid);
    createMatch(
      io,
      { uid: invite.fromUid, displayName: invite.fromDisplayName, rating: invite.fromRating, socketId: fromSocketId, joinedAt: Date.now() },
      { uid, displayName: accepterProfile.displayName, rating: accepterProfile.rating, socketId: socket.id, joinedAt: Date.now() },
    );
  });
}

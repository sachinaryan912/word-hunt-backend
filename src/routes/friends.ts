import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/firebase';
import { AuthedRequest } from '../middleware/authMiddleware';
import { getOrCreateProfile } from '../lib/profileStore';
import { sendPushToUser } from '../lib/notifications';

export const friendsRouter = Router();

async function acceptFriendship(uidA: string, uidB: string) {
  const [a, b] = await Promise.all([getOrCreateProfile(uidA), getOrCreateProfile(uidB)]);
  const batch = db.batch();
  batch.set(db.collection('players').doc(uidA).collection('friends').doc(uidB), {
    uid: b.uid,
    displayName: b.displayName,
    rating: b.rating,
    since: Date.now(),
  });
  batch.set(db.collection('players').doc(uidB).collection('friends').doc(uidA), {
    uid: a.uid,
    displayName: a.displayName,
    rating: a.rating,
    since: Date.now(),
  });
  await batch.commit();
}

friendsRouter.get('/', async (req: AuthedRequest, res) => {
  const snap = await db.collection('players').doc(req.uid!).collection('friends').get();
  res.json({ friends: snap.docs.map((d) => d.data()) });
});

friendsRouter.get('/requests', async (req: AuthedRequest, res) => {
  const snap = await db
    .collection('friendRequests')
    .where('toUid', '==', req.uid!)
    .where('status', '==', 'pending')
    .get();
  res.json({ requests: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
});

const requestSchema = z.object({ toUid: z.string().min(1) });

friendsRouter.post('/requests', async (req: AuthedRequest, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const fromUid = req.uid!;
  const { toUid } = parsed.data;
  if (toUid === fromUid) {
    res.status(400).json({ error: 'cannot_friend_self' });
    return;
  }

  const already = await db.collection('players').doc(fromUid).collection('friends').doc(toUid).get();
  if (already.exists) {
    res.status(409).json({ error: 'already_friends' });
    return;
  }

  // If the target already sent a pending request to me, accept it as a mutual match instead of duplicating.
  const reverseRef = db.collection('friendRequests').doc(`${toUid}_${fromUid}`);
  const reverseSnap = await reverseRef.get();
  if (reverseSnap.exists && reverseSnap.data()!.status === 'pending') {
    await acceptFriendship(fromUid, toUid);
    await reverseRef.update({ status: 'accepted' });
    res.json({ status: 'accepted' });
    return;
  }

  const forwardRef = db.collection('friendRequests').doc(`${fromUid}_${toUid}`);
  const forwardSnap = await forwardRef.get();
  if (forwardSnap.exists && forwardSnap.data()!.status === 'pending') {
    res.json({ status: 'pending' });
    return;
  }

  const fromProfile = await getOrCreateProfile(fromUid);
  await forwardRef.set({
    fromUid,
    toUid,
    fromDisplayName: fromProfile.displayName,
    status: 'pending',
    createdAt: Date.now(),
  });
  void sendPushToUser(toUid, 'New friend request', `${fromProfile.displayName} wants to be friends`, {
    type: 'friend_request',
  });
  res.json({ status: 'pending' });
});

type RequestClaim =
  | { ok: true; fromUid: string; toUid: string }
  | { ok: false; status: 404 | 403 | 409; error: string };

friendsRouter.post('/requests/:id/accept', async (req: AuthedRequest, res) => {
  const ref = db.collection('friendRequests').doc(String(req.params.id));
  // Claiming the request (pending -> accepted) inside a transaction closes
  // the race where two concurrent accept calls both read status 'pending'
  // before either write lands — only one can win the transaction here, the
  // other gets 'not_pending' below instead of both running acceptFriendship.
  const claim: RequestClaim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'not_found' };
    const data = snap.data()!;
    if (data.toUid !== req.uid) return { ok: false, status: 403, error: 'forbidden' };
    if (data.status !== 'pending') return { ok: false, status: 409, error: 'not_pending' };
    tx.update(ref, { status: 'accepted' });
    return { ok: true, fromUid: data.fromUid as string, toUid: data.toUid as string };
  });
  if (!claim.ok) {
    res.status(claim.status).json({ error: claim.error });
    return;
  }
  await acceptFriendship(claim.fromUid, claim.toUid);
  res.json({ status: 'accepted' });
});

friendsRouter.post('/requests/:id/decline', async (req: AuthedRequest, res) => {
  const ref = db.collection('friendRequests').doc(String(req.params.id));
  const claim: RequestClaim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'not_found' };
    const data = snap.data()!;
    if (data.toUid !== req.uid) return { ok: false, status: 403, error: 'forbidden' };
    tx.update(ref, { status: 'declined' });
    return { ok: true, fromUid: data.fromUid as string, toUid: data.toUid as string };
  });
  if (!claim.ok) {
    res.status(claim.status).json({ error: claim.error });
    return;
  }
  res.json({ status: 'declined' });
});

friendsRouter.delete('/:uid', async (req: AuthedRequest, res) => {
  const me = req.uid!;
  const other = String(req.params.uid);
  const batch = db.batch();
  batch.delete(db.collection('players').doc(me).collection('friends').doc(other));
  batch.delete(db.collection('players').doc(other).collection('friends').doc(me));
  await batch.commit();
  res.json({ status: 'removed' });
});

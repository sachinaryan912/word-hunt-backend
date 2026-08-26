import { db } from './firebase';
import { sendPushToUsers } from './notifications';
import { PlayerProfileDoc } from '../types';

const META_REF = db.collection('appMeta').doc('android');

/** Compares the deployed latest version code against the last one we
 * notified users about. If it went up, pushes an "update available"
 * notification to every user with notifications enabled and records the
 * new baseline so it only fires once per version bump. Safe to call on
 * every server boot. */
export async function checkAndNotifyUpdate(latestVersionCode: number) {
  try {
    const snap = await META_REF.get();
    const lastNotifiedVersion = snap.exists ? (snap.data()!.latestVersionCode as number) : null;

    if (lastNotifiedVersion === null) {
      // First boot with this feature enabled — record the baseline without
      // mass-notifying everyone for a version they may already have.
      await META_REF.set({ latestVersionCode });
      return;
    }
    if (latestVersionCode <= lastNotifiedVersion) return;

    await META_REF.set({ latestVersionCode });

    const playersSnap = await db.collection('players').where('notificationsEnabled', '==', true).get();
    const targets = playersSnap.docs
      .map((doc) => doc.data() as PlayerProfileDoc)
      .filter((p) => p.fcmToken)
      .map((p) => ({ uid: p.uid, fcmToken: p.fcmToken! }));

    await sendPushToUsers(targets, 'Update available', 'A new version of Word Hunting is ready — update now for the latest fixes and features.', {
      type: 'app_update',
    });
  } catch (err) {
    console.error('update notifier failed', err);
  }
}

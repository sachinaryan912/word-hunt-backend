import { getMessaging } from 'firebase-admin/messaging';
import { getOrCreateProfile } from './profileStore';

/** Sends a push to a user if they have a token and haven't opted out. Never throws. */
export async function sendPushToUser(uid: string, title: string, body: string, data: Record<string, string> = {}) {
  try {
    const profile = await getOrCreateProfile(uid);
    if (!profile.notificationsEnabled || !profile.fcmToken) return;

    await getMessaging().send({
      token: profile.fcmToken,
      notification: { title, body },
      data,
    });
  } catch (err) {
    console.error(`failed to send push to ${uid}`, err);
  }
}

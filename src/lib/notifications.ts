import { getMessaging } from 'firebase-admin/messaging';
import { getOrCreateProfile, profileRef } from './profileStore';

// FCM's terminal codes for a token that will never succeed again (app
// uninstalled, data cleared, token rotated out from under us). Retrying
// these forever just wastes calls, so we drop the dead token instead.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

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
    const code = (err as { code?: string }).code;
    if (code && DEAD_TOKEN_CODES.has(code)) {
      await profileRef(uid).update({ fcmToken: null }).catch(() => {});
    } else {
      console.error(`failed to send push to ${uid}`, err);
    }
  }
}

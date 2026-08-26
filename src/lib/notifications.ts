import { getMessaging } from 'firebase-admin/messaging';
import { getOrCreateProfile, profileRef } from './profileStore';
import { chunk } from './friends';

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

/**
 * Bulk push for broadcast-style notifications (daily reminder, app update).
 * Callers must already have each user's token — typically from the same
 * Firestore query that decided who to notify — so this never re-fetches
 * profiles. Sends via FCM's multicast API (500 tokens/call, vs. one
 * `send()` per user) and prunes any dead tokens the response reports back.
 */
export async function sendPushToUsers(
  users: { uid: string; fcmToken: string }[],
  title: string,
  body: string,
  data: Record<string, string> = {},
): Promise<void> {
  for (const group of chunk(users, 500)) {
    try {
      const res = await getMessaging().sendEachForMulticast({
        tokens: group.map((u) => u.fcmToken),
        notification: { title, body },
        data,
      });
      await Promise.all(
        res.responses.map(async (r, i) => {
          if (r.success) return;
          const code = (r.error as { code?: string } | undefined)?.code;
          if (code && DEAD_TOKEN_CODES.has(code)) {
            await profileRef(group[i].uid).update({ fcmToken: null }).catch(() => {});
          } else {
            console.error(`failed to send push to ${group[i].uid}`, r.error);
          }
        }),
      );
    } catch (err) {
      console.error('bulk push failed', err);
    }
  }
}

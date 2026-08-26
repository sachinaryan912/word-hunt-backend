import { db } from './firebase';
import { todayDateKey } from './dailyChallenge';
import { sendPushToUsers } from './notifications';
import { PlayerProfileDoc } from '../types';

const REMINDER_HOUR_UTC = 18;
let lastSentDate: string | null = null;

async function runReminderPass() {
  const today = todayDateKey();
  const [playersSnap, resultsSnap] = await Promise.all([
    db.collection('players').where('notificationsEnabled', '==', true).get(),
    db.collection('dailyResults').where('date', '==', today).get(),
  ]);
  const completedUids = new Set(resultsSnap.docs.map((d) => d.data().uid as string));

  const targets = playersSnap.docs
    .map((doc) => doc.data() as PlayerProfileDoc)
    .filter((p) => !completedUids.has(p.uid) && p.fcmToken)
    .map((p) => ({ uid: p.uid, fcmToken: p.fcmToken! }));

  await sendPushToUsers(targets, "Today's word hunt awaits", "Complete today's daily challenge before it resets!", {
    type: 'daily_reminder',
  });
}

/**
 * Checks hourly; sends the daily-challenge reminder push once per calendar
 * day at or after a fixed UTC hour. Cloud Run's CPU-throttled-when-idle
 * billing means this interval can fire late (it only actually runs once the
 * container gets scheduled CPU, which happens when a request/socket event
 * arrives) — checking `>=` instead of `===` means a delayed tick still
 * sends today's reminder instead of silently missing the window, with no
 * extra cost.
 */
export function startDailyReminderLoop() {
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() < REMINDER_HOUR_UTC) return;
    const today = todayDateKey();
    if (lastSentDate === today) return;
    lastSentDate = today;
    runReminderPass().catch((err) => console.error('daily reminder loop failed', err));
  }, 60 * 60 * 1000);
}

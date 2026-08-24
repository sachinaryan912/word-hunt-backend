import { db } from './firebase';
import { todayDateKey } from './dailyChallenge';
import { sendPushToUser } from './notifications';
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

  for (const doc of playersSnap.docs) {
    const p = doc.data() as PlayerProfileDoc;
    if (completedUids.has(p.uid) || !p.fcmToken) continue;
    void sendPushToUser(p.uid, "Today's word hunt awaits", "Complete today's daily challenge before it resets!", {
      type: 'daily_reminder',
    });
  }
}

/** Checks hourly; sends the daily-challenge reminder push once per calendar day around a fixed UTC hour. */
export function startDailyReminderLoop() {
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() !== REMINDER_HOUR_UTC) return;
    const today = todayDateKey();
    if (lastSentDate === today) return;
    lastSentDate = today;
    runReminderPass().catch((err) => console.error('daily reminder loop failed', err));
  }, 60 * 60 * 1000);
}

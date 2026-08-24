import { db } from './firebase';
import { PlayerProfileDoc } from '../types';

export interface AchievementContext {
  hadComebackWin?: boolean;
  lastSoloTimeSeconds?: number;
  lastSoloAccuracy?: number;
  globalRank?: number | null;
}

export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  check: (profile: PlayerProfileDoc, ctx: AchievementContext) => boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_word', title: 'First Word', description: 'Find your first word', check: (p) => p.wordsFoundTotal >= 1 },
  { id: 'first_win', title: 'First Win', description: 'Win your first multiplayer match', check: (p) => p.wins >= 1 },
  {
    id: 'speed_hunter',
    title: 'Speed Hunter',
    description: 'Complete a solo level in under 60 seconds',
    check: (_p, ctx) => (ctx.lastSoloTimeSeconds ?? Infinity) <= 60,
  },
  { id: 'ten_wins', title: '10 Wins', description: 'Win 10 multiplayer matches', check: (p) => p.wins >= 10 },
  { id: 'hundred_words', title: '100 Words', description: 'Find 100 words in total', check: (p) => p.wordsFoundTotal >= 100 },
  {
    id: 'perfect_level',
    title: 'Perfect Level',
    description: 'Complete a solo level with 100% accuracy',
    check: (_p, ctx) => (ctx.lastSoloAccuracy ?? 0) >= 100,
  },
  {
    id: 'comeback',
    title: 'Comeback',
    description: 'Win a match after trailing behind',
    check: (_p, ctx) => ctx.hadComebackWin === true,
  },
  { id: 'ten_win_streak', title: '10 Win Streak', description: 'Reach a 10-match winning streak', check: (p) => p.bestStreak >= 10 },
  {
    id: 'daily_challenger',
    title: 'Daily Challenger',
    description: 'Complete a daily challenge',
    check: (p) => (p.dailyChallengesCompleted ?? 0) >= 1,
  },
  {
    id: 'global_top_100',
    title: 'Global Top 100',
    description: 'Reach the top 100 on the global leaderboard',
    check: (_p, ctx) => ctx.globalRank !== null && ctx.globalRank !== undefined && ctx.globalRank <= 100,
  },
];

/** Idempotent: only grants achievements not already recorded for this uid. Returns newly-granted ids. */
export async function checkAndGrantAchievements(
  uid: string,
  profile: PlayerProfileDoc,
  ctx: AchievementContext = {},
): Promise<string[]> {
  const col = db.collection('players').doc(uid).collection('achievements');
  const eligible = ACHIEVEMENTS.filter((def) => def.check(profile, ctx));
  if (eligible.length === 0) return [];

  const snaps = await Promise.all(eligible.map((def) => col.doc(def.id).get()));
  const toGrant = eligible.filter((_, i) => !snaps[i].exists);
  await Promise.all(
    toGrant.map((def) => col.doc(def.id).set({ id: def.id, title: def.title, unlockedAt: Date.now() })),
  );
  return toGrant.map((d) => d.id);
}

export async function getAchievementsForUser(uid: string) {
  const col = db.collection('players').doc(uid).collection('achievements');
  const snap = await col.get();
  const unlocked = new Map(snap.docs.map((d) => [d.id, d.data().unlockedAt as number]));
  return ACHIEVEMENTS.map((def) => ({
    id: def.id,
    title: def.title,
    description: def.description,
    isUnlocked: unlocked.has(def.id),
    unlockedAt: unlocked.get(def.id) ?? null,
  }));
}

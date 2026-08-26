import { db } from './firebase';
import { PlayerProfileDoc } from '../types';

const PLAYERS = 'players';

export function defaultProfile(uid: string): PlayerProfileDoc {
  const now = Date.now();
  return {
    uid,
    displayName: `Guest-${uid.slice(0, 6)}`,
    avatar: '',
    level: 1,
    xp: 0,
    rating: 1200,
    wins: 0,
    losses: 0,
    gamesPlayed: 0,
    bestScore: 0,
    winStreak: 0,
    bestStreak: 0,
    wordsFoundTotal: 0,
    soloLevelsCompleted: 0,
    dailyChallengesCompleted: 0,
    fcmToken: null,
    notificationsEnabled: true,
    bestDailyRank: null,
    adRewardsDate: null,
    adRewardsClaimed: 0,
    dailyGiftDate: null,
    dailyGiftFreeClaimed: false,
    dailyGiftAdClaimed: false,
    unlockedAvatars: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function getOrCreateProfile(uid: string): Promise<PlayerProfileDoc> {
  const ref = db.collection(PLAYERS).doc(uid);
  const snap = await ref.get();
  if (snap.exists) {
    return snap.data() as PlayerProfileDoc;
  }
  const profile = defaultProfile(uid);
  await ref.set(profile);
  return profile;
}

export function profileRef(uid: string) {
  return db.collection(PLAYERS).doc(uid);
}

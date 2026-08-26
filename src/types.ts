export interface PlayerProfileDoc {
  uid: string;
  displayName: string;
  avatar: string;
  level: number;
  xp: number;
  rating: number;
  wins: number;
  losses: number;
  gamesPlayed: number;
  bestScore: number;
  winStreak: number;
  bestStreak: number;
  wordsFoundTotal: number;
  soloLevelsCompleted: number;
  dailyChallengesCompleted: number;
  fcmToken: string | null;
  notificationsEnabled: boolean;
  bestDailyRank: number | null;
  adRewardsDate: string | null;
  adRewardsClaimed: number;
  dailyGiftDate: string | null;
  dailyGiftFreeClaimed: boolean;
  dailyGiftAdClaimed: boolean;
  unlockedAvatars: string[];
  roomsCreatedDate: string | null;
  roomsCreatedToday: number;
  createdAt: number;
  updatedAt: number;
}

export type Direction =
  | 'E'
  | 'W'
  | 'N'
  | 'S'
  | 'SE'
  | 'SW'
  | 'NE'
  | 'NW';

export interface GeneratedBoard {
  rows: number;
  cols: number;
  grid: string[][];
  targetWords: string[];
  seed: string;
  generatorVersion: string;
}

export interface GridPos {
  row: number;
  col: number;
}

export interface MatchPlayerState {
  uid: string;
  displayName: string;
  rating: number;
  score: number;
  wordsFound: number;
  connected: boolean;
  socketId: string | null;
  wasBehind: boolean;
  hadComebackWin: boolean;
  /** A simulated opponent used when no real player is available in the
   * matchmaking queue. Bots never touch Firestore — no profile doc, no
   * leaderboard entry, no achievements — only the real player's rating,
   * XP, and stats are written when a bot match ends. */
  isBot?: boolean;
}

export interface ActiveMatch {
  matchId: string;
  board: GeneratedBoard;
  players: [MatchPlayerState, MatchPlayerState];
  claimedWords: Map<string, { claimedBy: string; path: GridPos[]; score: number }>;
  startAt: number;
  endAt: number;
  durationSeconds: number;
  status: 'active' | 'ended';
  endTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
}

export interface QueueEntry {
  uid: string;
  displayName: string;
  rating: number;
  socketId: string;
  joinedAt: number;
  blockedUids?: Set<string>;
  isBot?: boolean;
}

export interface FriendMatchInvite {
  inviteId: string;
  fromUid: string;
  fromDisplayName: string;
  fromRating: number;
  toUid: string;
  createdAt: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

export interface RoomState {
  code: string;
  hostUid: string;
  hostDisplayName: string;
  hostRating: number;
  hostSocketId: string;
  hostReady: boolean;
  guestUid: string | null;
  guestDisplayName: string | null;
  guestRating: number | null;
  guestSocketId: string | null;
  guestReady: boolean;
  createdAt: number;
  expireTimer: ReturnType<typeof setTimeout> | null;
  // Tracks whether this room was ever actually used, so it can be refunded
  // against the host's daily free-room count/XP if it closes unused (e.g.
  // the host backs out right after generating a code, before anyone joins).
  guestEverJoined: boolean;
  xpCharged: number;
}

/** XP required to reach a given level (level 1 starts at 0 XP). */
export function xpForLevel(level: number): number {
  return (level - 1) * 200;
}

export function levelForXp(xp: number): number {
  return Math.floor(xp / 200) + 1;
}

export function xpProgress(xp: number): number {
  const level = levelForXp(xp);
  const floor = xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  return (xp - floor) / (ceiling - floor);
}

export const XP_SOLO_COMPLETE_BASE = 10;
export const XP_SOLO_PER_WORD = 5;
export const XP_MATCH_PARTICIPATION = 20;
export const XP_MATCH_WIN_BONUS = 30;

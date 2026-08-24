export const AVATAR_COST_XP = 30;
export const USERNAME_CHANGE_COST_XP = 100;

/** 20 purchasable avatars — client renders placeholder art per id until real assets are supplied. */
export const AVATAR_IDS: string[] = Array.from({ length: 20 }, (_, i) => `avatar_${String(i + 1).padStart(2, '0')}`);

export function isValidAvatarId(id: string): boolean {
  return AVATAR_IDS.includes(id);
}

export const AVATAR_COST_XP = 30;
export const USERNAME_CHANGE_COST_XP = 100;

/**
 * 34 purchasable avatars — ids match the SVG filenames the client ships at
 * assets/avtars/avtarN.svg (word-hunting-app/assets/avtars), so id and asset
 * stay in lockstep with no separate mapping to keep in sync.
 */
export const AVATAR_IDS: string[] = Array.from({ length: 34 }, (_, i) => `avtar${i}`);

export function isValidAvatarId(id: string): boolean {
  return AVATAR_IDS.includes(id);
}

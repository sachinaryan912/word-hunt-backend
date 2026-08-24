const K_FACTOR = 32;

export type MatchOutcome = 1 | 0.5 | 0;

/** Standard ELO delta for player A given both ratings and A's outcome (1 win, 0.5 draw, 0 loss). */
export function ratingDelta(ratingA: number, ratingB: number, outcomeA: MatchOutcome): number {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  return Math.round(K_FACTOR * (outcomeA - expectedA));
}

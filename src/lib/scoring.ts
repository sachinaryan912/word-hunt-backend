/** Base score by word length, plus a bonus for claiming with more time left on the clock. */
export function scoreForWord(word: string, timeRemainingSec: number, matchDurationSec: number): number {
  const base = word.length * 10;
  const ratio = matchDurationSec > 0 ? Math.max(0, timeRemainingSec / matchDurationSec) : 0;
  const speedBonus = Math.round(ratio * 20);
  return base + speedBonus;
}

export function soloWordScore(word: string): number {
  return word.length * 10;
}

import { generateBoard } from './boardGenerator';

const DAILY_TIER = 3; // 10x10, 7 words — matches the existing Daily Challenge UI's grid size.
const LAUNCH_DATE = Date.UTC(2026, 0, 1);

export function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function puzzleNumberFor(dateKey: string): number {
  const d = new Date(`${dateKey}T00:00:00Z`).getTime();
  const diffDays = Math.floor((d - LAUNCH_DATE) / 86400000);
  return Math.max(1, diffDays + 1);
}

export function generateDailyBoard(dateKey: string) {
  const seed = `daily-${dateKey}-v1`;
  return generateBoard(seed, DAILY_TIER);
}

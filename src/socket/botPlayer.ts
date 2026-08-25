import { Server } from 'socket.io';
import { ActiveMatch, GeneratedBoard, GridPos } from '../types';
import { claimWord } from './gameplay';

const DIRECTIONS: GridPos[] = [
  { row: 0, col: 1 }, { row: 0, col: -1 },
  { row: 1, col: 0 }, { row: -1, col: 0 },
  { row: 1, col: 1 }, { row: 1, col: -1 },
  { row: -1, col: 1 }, { row: -1, col: -1 },
];

/** The board only stores the finished grid + word list, not each word's
 * placement — this re-derives a straight-line path for the bot to "claim"
 * the word through the same validated pipeline a real player's drag uses. */
function findWordPath(board: GeneratedBoard, word: string): GridPos[] | null {
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) {
      if (board.grid[r][c] !== word[0]) continue;
      for (const dir of DIRECTIONS) {
        const path: GridPos[] = [];
        let ok = true;
        for (let i = 0; i < word.length; i++) {
          const rr = r + dir.row * i;
          const cc = c + dir.col * i;
          if (rr < 0 || rr >= board.rows || cc < 0 || cc >= board.cols || board.grid[rr][cc] !== word[i]) {
            ok = false;
            break;
          }
          path.push({ row: rr, col: cc });
        }
        if (ok) return path;
      }
    }
  }
  return null;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const botTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

/** Simulates a bot opponent "playing" a match — it finds target words on a
 * timer, at a pace and reliability scaled to its assigned rating, going
 * through the exact same claimWord pipeline a real player's word:select
 * would. Call cancelBotPlay when the match ends to clear pending timers. */
export function scheduleBotPlay(io: Server, match: ActiveMatch) {
  const bot = match.players.find((p) => p.isBot);
  if (!bot) return;

  let remaining = shuffled(match.board.targetWords);

  // Skill scales with the bot's rating: ~0 around 700 MMR, ~1 by 1900+.
  const skill = Math.min(1, Math.max(0, (bot.rating - 700) / 1200));
  const baseDelayMs = 9000 - skill * 5000; // ~9s at low skill down to ~4s at high skill
  const jitterMs = 4000;
  const findChance = 0.55 + skill * 0.4; // 55%-95% odds the bot lands each attempt

  const timers: ReturnType<typeof setTimeout>[] = [];
  const scheduleNext = (delayMs: number) => {
    const timer = setTimeout(() => {
      if (match.status !== 'active' || Date.now() >= match.endAt) return;

      const word = remaining.shift();
      if (word) {
        if (!match.claimedWords.has(word) && Math.random() < findChance) {
          const path = findWordPath(match.board, word);
          if (path) claimWord(io, match, bot.uid, word, path);
        } else if (!match.claimedWords.has(word)) {
          remaining.push(word); // missed this attempt — try again later
        }
      }

      remaining = remaining.filter((w) => !match.claimedWords.has(w));
      if (remaining.length > 0 && match.status === 'active') {
        scheduleNext(baseDelayMs + Math.random() * jitterMs);
      }
    }, delayMs);
    timers.push(timer);
  };

  scheduleNext(baseDelayMs / 2 + Math.random() * jitterMs);
  botTimers.set(match.matchId, timers);
}

export function cancelBotPlay(matchId: string) {
  const timers = botTimers.get(matchId);
  if (!timers) return;
  for (const timer of timers) clearTimeout(timer);
  botTimers.delete(matchId);
}

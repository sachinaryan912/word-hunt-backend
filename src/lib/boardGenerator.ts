import { Direction, GeneratedBoard, GridPos } from '../types';

export const GENERATOR_VERSION = 'v1';

/** xmur3 string hash -> 32-bit seed */
function hashSeed(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 deterministic PRNG -> function returning floats in [0,1) */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed: string): () => number {
  const hasher = hashSeed(seed);
  return mulberry32(hasher());
}

const DIRECTION_VECTORS: Record<Direction, GridPos> = {
  E: { row: 0, col: 1 },
  W: { row: 0, col: -1 },
  N: { row: -1, col: 0 },
  S: { row: 1, col: 0 },
  SE: { row: 1, col: 1 },
  SW: { row: 1, col: -1 },
  NE: { row: -1, col: 1 },
  NW: { row: -1, col: -1 },
};

const LETTER_FREQUENCY =
  'EEEEEEEEEEEETTTTTTTTTAAAAAAAAOOOOOOOOIIIIIIIINNNNNNNNSSSSSSSHHHHHHRRRRRRDDDDLLLLCCCUUUMMMWWFFGGYYPPBBVKJXQZ';

const WORD_BANK: string[] = [
  'CAT','DOG','SUN','RUN','BIG','TOP','RED','BOX','FOX','MAP',
  'STAR','MOON','FISH','BIRD','TREE','LAKE','GAME','WORD','HUNT','GOLD',
  'PARK','RAIN','SNOW','WIND','FIRE','ROCK','SAND','LEAF','SEED','ROOT',
  'PLANT','GRASS','CLOUD','RIVER','OCEAN','STORM','LIGHT','NIGHT','SPARK','FLAME',
  'QUICK','SWIFT','SHARP','BRAVE','QUIET','HAPPY','SMART','TIGER','EAGLE','SHARK',
  'PUZZLE','SEARCH','ISLAND','CASTLE','DRAGON','WIZARD','KNIGHT','ARCHER','FOREST',
  'DESERT','GLACIER','MYSTERY','JOURNEY','TREASURE','ADVENTURE','DISCOVERY','MOUNTAIN',
  'CHAMPION','VICTORY','GALAXY','PLANET','COMET','METEOR','ROCKET','ORBIT','ENERGY',
  'CRYSTAL','EMERALD','SAPPHIRE','DIAMOND','THUNDER','LIGHTNING','WHISPER','SHADOW',
  'PHOENIX','GRIFFIN','KRAKEN','PEGASUS','CENTAUR','WIZARDRY','ALCHEMY','ARCANE',
  'FALCON','PANTHER','JAGUAR','COBRA','VIPER','HAWK','WOLF','BEAR','LION','DEER',
];

interface DifficultyTier {
  rows: number;
  cols: number;
  wordCount: number;
  minLen: number;
  maxLen: number;
  directions: Direction[];
}

const TIERS: DifficultyTier[] = [
  { rows: 8, cols: 8, wordCount: 5, minLen: 3, maxLen: 5, directions: ['E', 'S'] },
  { rows: 9, cols: 9, wordCount: 6, minLen: 4, maxLen: 6, directions: ['E', 'S', 'SE', 'NE'] },
  { rows: 10, cols: 10, wordCount: 7, minLen: 4, maxLen: 7, directions: ['E', 'S', 'SE', 'NE', 'SW', 'NW'] },
  { rows: 11, cols: 11, wordCount: 8, minLen: 5, maxLen: 8, directions: ['E', 'S', 'SE', 'NE', 'SW', 'NW', 'W', 'N'] },
  { rows: 12, cols: 12, wordCount: 9, minLen: 5, maxLen: 9, directions: ['E', 'S', 'SE', 'NE', 'SW', 'NW', 'W', 'N'] },
];

/** Maps a 1-based difficulty tier (clamped 1-5) to a board config. */
export function tierForRating(avgRating: number): number {
  return Math.min(5, Math.max(1, Math.floor((avgRating - 800) / 200) + 1));
}

export function tierForLevel(level: number): number {
  return Math.min(5, Math.max(1, Math.ceil(level / 4)));
}

export function maxWordCountForTier(tierIndex: number): number {
  const tier = TIERS[Math.min(TIERS.length, Math.max(1, tierIndex)) - 1];
  return tier.wordCount;
}

function pickWords(rng: () => number, tier: DifficultyTier): string[] {
  const candidates = WORD_BANK.filter((w) => w.length >= tier.minLen && w.length <= tier.maxLen);
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(0, tier.wordCount);
  return picked.sort((a, b) => b.length - a.length);
}

function randomLetter(rng: () => number): string {
  return LETTER_FREQUENCY[Math.floor(rng() * LETTER_FREQUENCY.length)];
}

/** Deterministically generates a word-search board for the given seed + difficulty tier. */
export function generateBoard(seed: string, tierIndex: number): GeneratedBoard {
  const tier = TIERS[Math.min(TIERS.length, Math.max(1, tierIndex)) - 1];
  const rng = makeRng(seed);
  const grid: (string | null)[][] = Array.from({ length: tier.rows }, () =>
    Array.from({ length: tier.cols }, () => null),
  );

  const words = pickWords(rng, tier);
  const placedWords: string[] = [];

  for (const word of words) {
    let placed = false;
    for (let attempt = 0; attempt < 300 && !placed; attempt++) {
      const dirKey = tier.directions[Math.floor(rng() * tier.directions.length)];
      const vec = DIRECTION_VECTORS[dirKey];

      // Inclusive [min, max] range of valid start indices along one axis for this direction.
      const axisRange = (dim: number, step: number): [number, number] => {
        if (step === 0) return [0, dim - 1];
        if (step > 0) return [0, dim - word.length];
        return [word.length - 1, dim - 1];
      };
      const [minStartRow, maxStartRow] = axisRange(tier.rows, vec.row);
      const [minStartCol, maxStartCol] = axisRange(tier.cols, vec.col);

      if (maxStartRow < minStartRow || maxStartCol < minStartCol) continue;

      const startRow = minStartRow + Math.floor(rng() * (maxStartRow - minStartRow + 1));
      const startCol = minStartCol + Math.floor(rng() * (maxStartCol - minStartCol + 1));

      const cells: GridPos[] = [];
      let fits = true;
      for (let i = 0; i < word.length; i++) {
        const r = startRow + vec.row * i;
        const c = startCol + vec.col * i;
        if (r < 0 || r >= tier.rows || c < 0 || c >= tier.cols) {
          fits = false;
          break;
        }
        const existing = grid[r][c];
        if (existing !== null && existing !== word[i]) {
          fits = false;
          break;
        }
        cells.push({ row: r, col: c });
      }

      if (fits) {
        cells.forEach((pos, i) => {
          grid[pos.row][pos.col] = word[i];
        });
        placed = true;
        placedWords.push(word);
      }
    }
  }

  const finalGrid: string[][] = grid.map((row) => row.map((cell) => cell ?? randomLetter(rng)));

  return {
    rows: tier.rows,
    cols: tier.cols,
    grid: finalGrid,
    targetWords: placedWords,
    seed,
    generatorVersion: GENERATOR_VERSION,
  };
}

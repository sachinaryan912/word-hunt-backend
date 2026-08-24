import rateLimit from 'express-rate-limit';

export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

export const mutationRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Simple in-memory token bucket for socket events (per socket id). */
export class SocketRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private maxEvents: number,
    private windowMs: number,
  ) {}

  allow(socketId: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.hits.get(socketId) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.maxEvents) {
      this.hits.set(socketId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.hits.set(socketId, timestamps);
    return true;
  }

  clear(socketId: string) {
    this.hits.delete(socketId);
  }
}

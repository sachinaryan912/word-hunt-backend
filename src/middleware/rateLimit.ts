import { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { AuthedRequest } from './authMiddleware';

export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Mounted after authMiddleware on every route that uses it, so req.uid is
// always set here — key by uid (not IP) so the cap actually tracks a single
// user regardless of how many IPs/devices they use, and so users sharing one
// IP/NAT don't share (and prematurely exhaust) the same bucket.
export const mutationRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req as AuthedRequest).uid ?? ipKeyGenerator(req.ip ?? ''),
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

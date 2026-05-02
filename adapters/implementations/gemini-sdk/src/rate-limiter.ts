/**
 * Shared Gemini API rate limiter.
 *
 * Uses globalThis-keyed singleton so the same PQueue is reused
 * across dynamic imports and test isolation boundaries.
 */
import PQueue from 'p-queue';

/** Symbol key for truly global rate limiter (survives module re-imports). */
const GEMINI_RATE_LIMITER_KEY = Symbol.for('makaio.gemini.rateLimiter');

/**
 * Get or create the global rate limiter.
 *
 * Uses globalThis to ensure singleton across all module contexts (test isolation, dynamic imports).
 * Interval of 3s balances quota protection with test performance.
 * @returns Shared PQueue instance for rate limiting Gemini API calls
 */
export function getGeminiRateLimiter(): PQueue {
  const global = globalThis as Record<symbol, PQueue>;
  if (!global[GEMINI_RATE_LIMITER_KEY]) {
    global[GEMINI_RATE_LIMITER_KEY] = new PQueue({ concurrency: 1, interval: 3000, intervalCap: 1 });
  }
  return global[GEMINI_RATE_LIMITER_KEY];
}

/** Pre-resolved singleton for synchronous access. */
export const geminiRateLimiter = getGeminiRateLimiter();

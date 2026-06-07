/**
 * Generic HMAC-signed single-use OAuth state token manager.
 *
 * State tokens are created with a random ID, HMAC-signed with a secret, and
 * stored in memory with a TTL. On consumption the token is verified and
 * removed (single-use), preventing replay attacks.
 * @example
 * ```typescript
 * const manager = new OAuthStateManager<{ machineId: string; redirectUri: string }>(secret);
 * const token = manager.create({ machineId: 'machine-1', redirectUri: 'https://example.com' });
 * const state = manager.consume(token); // returns the state once, then null
 * ```
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default TTL for OAuth state tokens (5 minutes). */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Valid non-empty hex string. */
const HEX_PATTERN = /^[\da-f]+$/i;

/** Internal storage shape that keeps manager metadata separate from caller state. */
type StoredState<TState extends object> = {
  readonly createdAt: number;
  readonly payload: TState;
};

/**
 * Manages OAuth state tokens during an authorization flow.
 *
 * Tokens are HMAC-signed (SHA-256) to prevent forgery, single-use to prevent
 * replay, and TTL-limited to prevent stale-state attacks.
 * @typeParam TState - Shape of the caller-supplied state payload.
 *
 * ## Security properties
 * - Tokens are bound to the secret used at construction time.
 * - Consuming a token removes it immediately (single-use).
 * - Tokens that exceed `ttlMs` are rejected on consumption.
 * - `cleanup()` removes expired entries from the internal map.
 */
export class OAuthStateManager<TState extends object> {
  private readonly states = new Map<string, StoredState<TState>>();

  private readonly secret: string;

  /**
   * Create a new OAuth state manager.
   * @param secret - HMAC signing secret. Must be kept confidential. Leading
   * and trailing whitespace is ignored.
   * @param ttlMs - Positive finite token lifetime in milliseconds. Defaults
   * to 5 minutes.
   */
  public constructor(
    secret: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {
    const normalizedSecret = secret.trim();
    if (normalizedSecret.length === 0) {
      throw new Error('OAuthStateManager requires a non-empty HMAC secret');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('OAuthStateManager requires ttlMs to be a positive finite number');
    }
    this.secret = normalizedSecret;
  }

  /**
   * Create a signed single-use state token for the given payload.
   * @param state - Caller-supplied state to embed in the token.
   * @returns Signed token string in the format `{stateId}.{signature}`.
   */
  public create(state: TState): string {
    const stateId = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', this.secret).update(stateId).digest('hex');
    this.states.set(stateId, { createdAt: Date.now(), payload: { ...state } });
    return `${stateId}.${signature}`;
  }

  /**
   * Validate and consume a state token.
   *
   * Returns the original state payload when the token is valid, unexpired, and
   * has not been consumed before. Returns `null` for any invalid token.
   * @param token - Token string previously returned by {@link OAuthStateManager.create}.
   * @returns Original state payload, or `null` when the token is invalid or expired.
   */
  public consume(token: string): TState | null {
    const dotIndex = token.indexOf('.');
    if (dotIndex === -1) return null;
    const stateId = token.slice(0, dotIndex);
    const signature = token.slice(dotIndex + 1);
    if (!stateId || !signature) return null;
    if (signature.includes('.')) return null;

    const expectedSignature = createHmac('sha256', this.secret).update(stateId).digest('hex');
    if (!safeEqualHex(signature, expectedSignature)) return null;

    const stored = this.states.get(stateId);
    if (!stored) return null;
    this.states.delete(stateId);

    if (Date.now() - stored.createdAt > this.ttlMs) return null;

    return stored.payload;
  }

  /**
   * Remove all expired state tokens from the internal map.
   *
   * Call this periodically to avoid memory growth when tokens are never
   * consumed (e.g., the user abandons the OAuth flow).
   */
  public cleanup(): void {
    const now = Date.now();
    for (const [id, stored] of this.states) {
      if (now - stored.createdAt > this.ttlMs) {
        this.states.delete(id);
      }
    }
  }

  /**
   * Number of pending (not yet consumed or cleaned-up) state tokens.
   * @returns Count of pending state tokens.
   */
  public get pendingCount(): number {
    return this.states.size;
  }
}

/**
 * Compare two hex strings in constant time to prevent timing attacks.
 * @param a - First hex-encoded string.
 * @param b - Second hex-encoded string.
 * @returns `true` when both strings represent identical byte sequences.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0 || a.length % 2 !== 0) return false;
  if (!HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) return false;
  const aBuffer = Buffer.from(a, 'hex');
  const bBuffer = Buffer.from(b, 'hex');
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

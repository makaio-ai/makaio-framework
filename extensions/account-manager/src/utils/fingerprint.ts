import { createHash } from 'node:crypto';

/** Number of hex characters to use from the SHA-256 hash */
const FINGERPRINT_LENGTH = 16;

/**
 * Computes a stable fingerprint from a token string.
 *
 * Uses the first {@link FINGERPRINT_LENGTH} hex characters of the SHA-256 hash.
 * This is used to identify accounts without storing the raw token in the
 * public account map.
 * @param token - The long-lived token (e.g. refreshToken) to fingerprint
 * @returns Hex prefix of the SHA-256 hash
 */
export function computeFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

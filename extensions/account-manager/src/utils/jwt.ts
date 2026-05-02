/**
 * Decodes a JWT payload without signature verification.
 *
 * This helper is for display metadata only. Callers must not use unverified
 * claims as an authentication or authorization decision.
 * @param jwt - The JWT string.
 * @returns The decoded payload, or null when the token is malformed.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

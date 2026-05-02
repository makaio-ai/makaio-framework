/**
 * Shared normalization for the `MAKAIO_BUS_SECRET` environment variable.
 *
 * Applies consistent trim-and-reject logic so every entry-point (CLI serve,
 * config provider, …) behaves identically when reading the secret.
 */

/**
 * Normalize a raw `MAKAIO_BUS_SECRET` value.
 *
 * - `undefined` (variable unset) → returns `undefined`
 * - Non-empty string after trimming → returns the trimmed value
 * - Empty string or whitespace-only → throws, because a secret that collapses
 *   to the empty string is almost certainly a misconfiguration and must not
 *   silently fall back to unauthenticated mode.
 * @param raw - The raw environment variable value, or `undefined` when unset.
 * @returns The trimmed secret string, or `undefined` when the variable is unset.
 * @throws When the variable is set but evaluates to an empty string after trimming.
 */
export function normalizeBusSecret(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();

  if (trimmed === '') {
    throw new Error('MAKAIO_BUS_SECRET is set but empty after trimming; refusing to use an empty secret');
  }

  return trimmed;
}

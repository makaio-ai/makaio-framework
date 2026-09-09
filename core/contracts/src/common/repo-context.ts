import { z } from 'zod';

/** Stable repository identity shared across framework contracts. */
export const RepoContextSchema = z.object({
  kind: z.string().trim().min(1).regex(/\S/),
  path: z.string().trim().min(1).regex(/\S/),
});

/** Stable repository identity shared across framework contracts. */
export type RepoContext = z.infer<typeof RepoContextSchema>;

/**
 * Normalize provider-specific identity rules used by common repository comparisons.
 * @param repoContext - Repository identity to normalize.
 * @returns Normalized repository identity.
 */
export function normalizeRepoContext(repoContext: RepoContext): RepoContext {
  const normalized = RepoContextSchema.parse(repoContext);
  if (normalized.kind === 'github-cloud') {
    return { kind: normalized.kind, path: normalized.path.toLowerCase() };
  }
  return normalized;
}

/**
 * Format a normalized repository identity using the `kind:path` grammar.
 * Structured identities may use arbitrary kinds, but this serialized form
 * reserves the colon as its delimiter and rejects kinds containing one.
 * @param repoContext - Repository identity to format.
 * @returns Stable normalized key.
 */
export function formatRepoContextKey(repoContext: RepoContext): string {
  const normalized = normalizeRepoContext(repoContext);
  if (normalized.kind.includes(':')) {
    throw new Error("Cannot format repository key: kind must not contain ':'");
  }
  return `${normalized.kind}:${normalized.path}`;
}

/**
 * Parse a stable repository key, preserving colons within its path.
 * @param value - Repository key to parse.
 * @returns Normalized identity, or null when the key is invalid.
 */
export function parseRepoContextKey(value: string): RepoContext | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;

  const parsed = RepoContextSchema.safeParse({
    kind: value.slice(0, separator).trim(),
    path: value.slice(separator + 1).trim(),
  });
  return parsed.success ? normalizeRepoContext(parsed.data) : null;
}

/**
 * Compare repository identities using their provider-specific normalization.
 * @param left - First repository identity.
 * @param right - Second repository identity.
 * @returns Whether both identities name the same repository.
 */
export function sameRepoContext(left: RepoContext, right: RepoContext): boolean {
  const normalizedLeft = normalizeRepoContext(left);
  const normalizedRight = normalizeRepoContext(right);
  return normalizedLeft.kind === normalizedRight.kind && normalizedLeft.path === normalizedRight.path;
}

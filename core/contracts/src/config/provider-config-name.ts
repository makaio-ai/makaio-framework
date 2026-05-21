/**
 * Convert a provider-config display name into its canonical routing slug.
 *
 * Trims surrounding whitespace, lowercases, and collapses interior whitespace
 * runs to hyphens so case-insensitive matching and uniqueness checks share one
 * normalization rule.
 * @param value - Provider-config display name.
 * @returns Canonical lowercase slug.
 */
export function slugifyProviderConfigName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Returns true when the given provider-config name can serve as a canonical
 * routing name.
 *
 * Canonical names must not contain `::`, `~`, or `/`, and their slugified form
 * must match `^[a-z0-9][a-z0-9._-]*$`.
 * @param value - Candidate provider-config name.
 * @returns `true` when the value is canonical.
 */
export function isCanonicalProviderConfigName(value: string): boolean {
  if (value.includes('::') || value.includes('~') || value.includes('/')) {
    return false;
  }

  const slug = slugifyProviderConfigName(value);
  return slug.length > 0 && /^[a-z0-9][a-z0-9._-]*$/.test(slug);
}

/**
 * Resolve the canonical display name a provider-config create flow should use.
 *
 * Preference order:
 * 1. explicit user-supplied name (trimmed only; canonical validation happens in
 *    the caller's input schema)
 * 2. provider definition display name when it is already canonical
 * 3. provider definition id when it is canonical
 *
 * Returns `undefined` when no derived fallback satisfies the canonical-name
 * contract.
 * @param options - Candidate name inputs.
 * @returns Trimmed explicit name or a canonical derived fallback, or `undefined`
 * when no candidate fits.
 */
export function resolveCanonicalProviderConfigName(options: {
  requestedName?: string;
  providerName?: string;
  definitionId: string;
}): string | undefined {
  const requestedName = options.requestedName?.trim();
  if (requestedName) {
    return requestedName;
  }

  const providerName = options.providerName?.trim();
  if (providerName && isCanonicalProviderConfigName(providerName)) {
    return providerName;
  }

  if (isCanonicalProviderConfigName(options.definitionId)) {
    return options.definitionId;
  }

  return undefined;
}

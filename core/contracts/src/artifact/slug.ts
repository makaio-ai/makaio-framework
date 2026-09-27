import { z } from 'zod';
import { readArtifactTitle } from './kind-paths.js';

/**
 * Lowercase alphanumeric segments joined by single or double hyphens
 * (`my-slug`, `my--slug`); no leading or trailing hyphen, no uppercase, no
 * other characters. Comparison is exact — the store never normalizes a slug.
 *
 * Public on purpose: a consumer store validates backfilled slugs and builds
 * its column check against this pattern, and {@link ARTIFACT_SLUG_FIELD} names
 * the legacy `data.slug` key a migration strips. Both are contract, not
 * implementation detail.
 */
export const ARTIFACT_SLUG_PATTERN = /^[a-z0-9]+(--?[a-z0-9]+)*$/;

/**
 * Human-readable envelope address of an artifact, unique per kind and scope.
 *
 * The slug is part of the envelope next to `kind` and `id`: every artifact has
 * one, it is assigned at creation, and it never changes across revisions. A
 * kind must not declare a data field named `slug` — the envelope owns it.
 *
 * Uniqueness per kind and scope is a store invariant, not a declared
 * `ArtifactUniquenessRuleSchema` rule: rules select data paths and
 * relation targets, and a kind cannot opt out of the envelope address. The
 * store enforces it structurally (a unique index over kind, scope, and slug)
 * and reports a collision as a conflict.
 */
export const ArtifactSlugSchema = z
  .string()
  .regex(ARTIFACT_SLUG_PATTERN, 'Slug must be lowercase alphanumeric segments joined by hyphens.');

/** Envelope address of an artifact, unique per kind and scope. */
export type ArtifactSlug = z.infer<typeof ArtifactSlugSchema>;

/** Name of the reserved envelope field that kinds may not declare in `data`. */
export const ARTIFACT_SLUG_FIELD = 'slug';

/** Rejection reason both payload validators report for a top-level `data.slug`. */
export const ARTIFACT_SLUG_RESERVED_MESSAGE = 'Data field slug is reserved: the artifact envelope owns the slug';

/** Letters that NFKD does not decompose into a base letter, transliterated the German way. */
const TRANSLITERATIONS: readonly (readonly [RegExp, string])[] = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/ø/g, 'oe'],
];

/**
 * Derive a slug from free text, typically the artifact title.
 *
 * German umlauts and ß are transliterated (`ä` → `ae`, `ß` → `ss`), other
 * diacritics are stripped, everything outside `[a-z0-9]` becomes a hyphen, and
 * runs of hyphens collapse to one. The result satisfies
 * {@link ARTIFACT_SLUG_PATTERN}; `null` means the text carries no usable
 * characters and the caller must choose another source.
 *
 * `slugify` is a pure normalization and does not limit the length. The
 * {@link ARTIFACT_DERIVED_SLUG_MAX_LENGTH} cap is applied by
 * {@link deriveArtifactSlug}, the single path every store-derived slug takes.
 * @param text - Free text such as an artifact title.
 * @returns A valid slug, or `null` when nothing remains after normalization.
 */
export function slugify(text: string): string | null {
  const transliterated = TRANSLITERATIONS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    text.toLowerCase(),
  );
  const normalized = transliterated
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : null;
}

/**
 * Upper bound, in characters, for a slug derived by {@link deriveArtifactSlug}.
 *
 * The bound applies before a store appends its collision suffix (`-2`, `-3`,
 * …), so a suffixed derived slug may exceed it. Caller-supplied slugs are not
 * cut, and {@link ArtifactSlugSchema} does not enforce this bound.
 */
export const ARTIFACT_DERIVED_SLUG_MAX_LENGTH = 80;

/**
 * Cut a valid slug to at most {@link ARTIFACT_DERIVED_SLUG_MAX_LENGTH}
 * characters. The cut falls on the last hyphen at or below the bound; when the
 * first segment alone is longer, it is a hard cut at the bound. Trailing
 * hyphens are stripped, so the result still satisfies
 * {@link ARTIFACT_SLUG_PATTERN}.
 * @param slug - A slug satisfying {@link ARTIFACT_SLUG_PATTERN}.
 * @returns The slug itself when within the bound, otherwise its cut prefix.
 */
function capDerivedSlug(slug: string): string {
  if (slug.length <= ARTIFACT_DERIVED_SLUG_MAX_LENGTH) return slug;
  const boundary = slug.lastIndexOf('-', ARTIFACT_DERIVED_SLUG_MAX_LENGTH);
  const cut = boundary > 0 ? slug.slice(0, boundary) : slug.slice(0, ARTIFACT_DERIVED_SLUG_MAX_LENGTH);
  return cut.replace(/-+$/, '');
}

/**
 * Derive the envelope slug a store assigns when a create request carries none.
 *
 * The title selected by the kind's `titlePath` is the source. When the title
 * yields no usable characters the artifact identity is the fallback, so a
 * derived slug always exists. Either source is capped at
 * {@link ARTIFACT_DERIVED_SLUG_MAX_LENGTH} characters: cut at the last hyphen
 * at or below the cap, hard-cut at the cap when the first segment alone is
 * longer, trailing hyphens stripped.
 * Stores disambiguate a derived slug that collides within its kind and scope
 * with a numeric suffix (`-2`, `-3`, …) appended after the cut, so a suffixed
 * slug may exceed the cap; only a caller-supplied slug rejects on collision,
 * and a caller-supplied slug is never cut.
 * @param data - Validated artifact data.
 * @param titlePath - Data-relative title path declared by the kind.
 * @param id - Artifact identity used when the title yields no slug.
 * @returns A slug satisfying {@link ARTIFACT_SLUG_PATTERN}, at most
 *   {@link ARTIFACT_DERIVED_SLUG_MAX_LENGTH} characters long.
 */
export function deriveArtifactSlug(data: Record<string, unknown>, titlePath: string, id: string): string {
  const fromTitle = slugify(readArtifactTitle(data, titlePath));
  if (fromTitle !== null) return capDerivedSlug(fromTitle);
  const fromId = slugify(id);
  if (fromId !== null) return capDerivedSlug(fromId);
  throw new Error(`Artifact ${id} yields no slug from its title or identity`);
}

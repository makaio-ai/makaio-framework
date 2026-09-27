import { z } from 'zod';
import { readArtifactTitle } from './kind-paths.js';

/**
 * Lowercase alphanumeric segments joined by single or double hyphens
 * (`my-slug`, `my--slug`); no leading or trailing hyphen, no uppercase, no
 * other characters. Comparison is exact — the store never normalizes a slug.
 */
export const ARTIFACT_SLUG_PATTERN = /^[a-z0-9]+(--?[a-z0-9]+)*$/;

/**
 * Human-readable envelope address of an artifact, unique per kind and scope.
 *
 * The slug is part of the envelope next to `kind` and `id`: every artifact has
 * one, it is assigned at creation, and it never changes across revisions. A
 * kind must not declare a data field named `slug` — the envelope owns it.
 */
export const ArtifactSlugSchema = z
  .string()
  .regex(ARTIFACT_SLUG_PATTERN, 'Slug must be lowercase alphanumeric segments joined by hyphens.');

/** Envelope address of an artifact, unique per kind and scope. */
export type ArtifactSlug = z.infer<typeof ArtifactSlugSchema>;

/** Name of the reserved envelope field that kinds may not declare in `data`. */
export const ARTIFACT_SLUG_FIELD = 'slug';

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
 * Derive the envelope slug a store assigns when a create request carries none.
 *
 * The title selected by the kind's `titlePath` is the source. When the title
 * yields no usable characters the artifact identity is the fallback, so a
 * derived slug always exists. Stores disambiguate a derived slug that collides
 * within its kind and scope with a numeric suffix (`-2`, `-3`, …); only a
 * caller-supplied slug rejects on collision.
 * @param data - Validated artifact data.
 * @param titlePath - Data-relative title path declared by the kind.
 * @param id - Artifact identity used when the title yields no slug.
 * @returns A slug satisfying {@link ARTIFACT_SLUG_PATTERN}.
 */
export function deriveArtifactSlug(data: Record<string, unknown>, titlePath: string, id: string): string {
  const fromTitle = slugify(readArtifactTitle(data, titlePath));
  if (fromTitle !== null) return fromTitle;
  const fromId = slugify(id);
  if (fromId !== null) return fromId;
  throw new Error(`Artifact ${id} yields no slug from its title or identity`);
}

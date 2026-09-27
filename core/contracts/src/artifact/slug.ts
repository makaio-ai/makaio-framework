import { z } from 'zod';

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
  .min(1)
  .regex(ARTIFACT_SLUG_PATTERN, 'Slug must be lowercase alphanumeric segments joined by hyphens.');

/** Envelope address of an artifact, unique per kind and scope. */
export type ArtifactSlug = z.infer<typeof ArtifactSlugSchema>;

/** Name of the reserved envelope field that kinds may not declare in `data`. */
export const ARTIFACT_SLUG_FIELD = 'slug';

const SLUG_SEPARATOR = '-';

/**
 * Derive a slug from free text, typically the artifact title.
 *
 * Diacritics are stripped, everything outside `[a-z0-9]` becomes a separator,
 * and runs of separators collapse to one hyphen. The result satisfies
 * {@link ARTIFACT_SLUG_PATTERN}; `null` means the text carries no usable
 * characters and the caller must choose another source.
 * @param text - Free text such as an artifact title.
 * @returns A valid slug, or `null` when nothing remains after normalization.
 */
export function slugify(text: string): string | null {
  const normalized = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, SLUG_SEPARATOR)
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : null;
}

/**
 * Convert a symbol name to a URL-safe API slug.
 * @param name - Raw symbol or file name.
 * @returns Lowercase alphanumeric slug.
 */
export function toApiSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (!slug) {
    throw new Error(`Cannot derive API slug from symbol name: ${name}`);
  }
  return slug;
}

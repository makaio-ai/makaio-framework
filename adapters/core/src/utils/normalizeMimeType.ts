/**
 * Normalize a MIME type string for comparison.
 *
 * Strips parameters (e.g., "; charset=utf-8") and converts to lowercase.
 * This ensures that values like "text/plain; charset=utf-8" or
 * "TEXT/PLAIN" are handled correctly.
 * Falls back to 'application/octet-stream' if mimeType is null/undefined.
 * @param mimeType - MIME type string to normalize.
 * @returns Normalized MIME type string (lowercase, no parameters).
 */
export function normalizeMimeType(mimeType: string | undefined | null): string {
  if (!mimeType) return 'application/octet-stream';
  // Strip parameters (e.g., "text/plain; charset=utf-8" -> "text/plain")
  const baseType = mimeType.split(';')[0].trim().toLowerCase();
  return baseType || 'application/octet-stream';
}

/**
 * Check if a MIME type represents text content that can be sent as a document.
 *
 * Covers `text/*` and common text-based `application/*` subtypes (JSON, XML,
 * SQL, GraphQL, JavaScript, TypeScript, YAML, TOML).
 * @param mimeType - MIME type string (parameters are allowed, e.g., "text/plain; charset=utf-8")
 * @returns True if the content is text-based.
 */
export function isTextLikeMimeType(mimeType: string | undefined | null): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (normalized.startsWith('text/')) return true;
  const textApplicationTypes = [
    'application/json',
    'application/xml',
    'application/sql',
    'application/graphql',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/toml',
  ];
  return textApplicationTypes.includes(normalized);
}

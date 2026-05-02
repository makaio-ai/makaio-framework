/**
 * FTS5 query utilities for SQLite full-text search.
 */

/**
 * Sanitizes a user query for safe use in FTS5 MATCH expressions.
 *
 * Each whitespace-delimited token is individually quoted to prevent FTS5
 * syntax injection (via operators like `OR`, `AND`, `NOT`, `*`, `^`) while
 * preserving multi-term implicit AND matching. Internal double-quote
 * characters are escaped as two consecutive double quotes per the FTS5
 * phrase-quoting convention.
 * @example
 * sanitizeFtsQuery('typescript generics') // → '"typescript" "generics"'
 * sanitizeFtsQuery('a "broken quote')     // → '"a" """broken" "quote"'
 * sanitizeFtsQuery('')                    // → '""'
 * @param query - Raw user input
 * @returns Sanitized FTS5 query string with each token individually quoted
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

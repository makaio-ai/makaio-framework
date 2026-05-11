import path from 'node:path';

/**
 * Shared utilities for processing README content in page generators.
 */

const GITHUB_CALLOUT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;

type GitHubCalloutType = (typeof GITHUB_CALLOUT_TYPES)[number];
type StarlightCalloutType = 'note' | 'tip' | 'caution' | 'danger';

const GITHUB_CALLOUT_TYPE_MAP: Record<GitHubCalloutType, StarlightCalloutType> = {
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'caution',
  WARNING: 'caution',
  CAUTION: 'danger',
};

const GITHUB_CALLOUT_RE = /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\r?\n((?:>[^\r\n]*\r?\n?)*)/gm;
const README_RELATIVE_LINK_RE = /(!?\[[^\]]*]\()(?!(?:#|[a-z][a-z0-9+.-]*:|\/))([^) \t\r\n]+)(#[^) \t\r\n]+)?\)/gi;

/**
 * Checks whether a regex capture is one of GitHub's supported callout labels.
 * @param value - Captured callout label.
 * @returns True when the label is in the supported GitHub callout vocabulary.
 */
function isGitHubCalloutType(value: string): value is GitHubCalloutType {
  return GITHUB_CALLOUT_TYPES.some((type) => type === value);
}

/**
 * Converts GitHub-flavored callout syntax (`> [!NOTE]`, `> [!IMPORTANT]`, etc.)
 * to Starlight admonition directives (`:::note`, `:::caution`, etc.).
 * @param body - Markdown body that may contain GitHub callout blocks.
 * @returns Markdown body with callouts converted to Starlight admonitions.
 */
export function convertGitHubCallouts(body: string): string {
  return body.replace(GITHUB_CALLOUT_RE, (_match, type: string, content: string) => {
    const starlightType = isGitHubCalloutType(type) ? GITHUB_CALLOUT_TYPE_MAP[type] : 'note';
    const inner = content.replaceAll('\r\n', '\n').replace(/^> ?/gm, '').trimEnd();
    return `:::${starlightType}\n${inner}\n:::\n`;
  });
}

/**
 * Rewrites README-relative Markdown links after generated pages relocate README
 * content. Normal links point to source browser URLs; image links point to raw
 * asset URLs so Markdown renderers can fetch the image bytes.
 * @param body - Markdown body from the README.
 * @param readmeDirFromRoot - README directory path relative to framework root.
 * @returns Markdown body with relative links rewritten to absolute GitHub URLs.
 */
export function normalizeReadmeRelativeLinks(body: string, readmeDirFromRoot: string): string {
  return body.replaceAll(README_RELATIVE_LINK_RE, (_match, prefix: string, href: string, hash = '') => {
    const sourcePath = path.posix.normalize(path.posix.join(readmeDirFromRoot, href));
    const baseUrl = prefix.startsWith('![')
      ? 'https://raw.githubusercontent.com/makaio-ai/makaio-framework/main'
      : 'https://github.com/makaio-ai/makaio-framework/blob/main';
    return `${prefix}${baseUrl}/${sourcePath}${String(hash)})`;
  });
}

const BLOCKQUOTE_BLOCK_RE = /^(?:>[^\r\n]*\r?\n?)+/;

/**
 * Strips leading blockquote blocks (including GitHub callouts) from markdown,
 * so that description-extraction helpers reach the first real paragraph.
 * @param body - Markdown body (after H1 removal and trimming).
 * @returns Body with leading blockquote lines removed.
 */
export function stripLeadingBlockquotes(body: string): string {
  let result = body;

  while (true) {
    const match = BLOCKQUOTE_BLOCK_RE.exec(result);
    if (!match) break;
    result = result.slice(match[0].length).trimStart();
  }
  return result;
}

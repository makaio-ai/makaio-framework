/**
 * Generates the content for a `.changeset/*.md` file from parsed config state.
 * @packageDocumentation
 */

import { humanId } from 'human-id';

import type { PackageBump } from './config-comment.js';

/**
 * Generates the markdown content for a changeset file.
 *
 * The format follows the Changesets convention:
 * ```markdown
 * ---
 * "@makaio/framework": minor
 * "@makaio/contracts": patch
 * ---
 *
 * - Change summary bullet.
 * ```
 *
 * When multiple packages are listed, each package's summaries are grouped
 * under a bold package-name heading so changelogs stay readable.
 * @param packages - Package names with their bump types and summaries.
 * @returns The complete changeset file content.
 */
export function generateChangesetContent(packages: readonly PackageBump[]): string {
  const frontmatter = packages.map(({ packageName, bump }) => `"${packageName}": ${bump}`).join('\n');

  let summary: string;
  if (packages.length === 1) {
    const pkg = packages[0];
    summary = pkg.summaries.length > 0 ? pkg.summaries.map((s) => `- ${s}`).join('\n') : 'No summary provided.';
  } else {
    const parts = packages
      .filter((p) => p.summaries.length > 0)
      .map((p) => `**${p.packageName}**\n${p.summaries.map((s) => `- ${s}`).join('\n')}`);
    summary = parts.length > 0 ? parts.join('\n\n') : 'No summary provided.';
  }

  return `---\n${frontmatter}\n---\n\n${summary}\n`;
}

/**
 * Generates a random changeset filename following the Changesets convention.
 * @returns A filename like `brave-cats-fly.md`.
 */
export function generateChangesetFilename(): string {
  return `${humanId({ separator: '-', capitalize: false })}.md`;
}

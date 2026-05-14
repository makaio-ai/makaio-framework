/**
 * Parses structured data from CodeRabbit's sticky walkthrough comment.
 *
 * Extracts per-row change entries (paths + summary) from the `## Changes` table.
 * @packageDocumentation
 */

const WALKTHROUGH_START = '<!-- walkthrough_start -->';
const CHANGES_HEADING = '## Changes';
const NEXT_HEADING_RE = /^## /m;

/** One row from the CodeRabbit Changes table. */
export interface CodeRabbitChangeRow {
  readonly paths: readonly string[];
  readonly summary: string;
}

/**
 * Strips trailing glob wildcards so the path can be matched as a directory prefix.
 *
 * `framework/packages/contracts/src/extension/*` → `framework/packages/contracts/src/extension/`
 * `**\/__tests__/**` → `__tests__/`
 * @param raw - Raw path string from the CodeRabbit comment.
 * @returns Cleaned path.
 */
function normalizePathGlob(raw: string): string {
  return raw.replace(/\/?\*+$/, '/').replace(/\*\*\//g, '');
}

/**
 * Extracts the Changes section text from the walkthrough comment.
 * @param commentBody - Raw markdown body.
 * @returns The text between `## Changes` and the next heading / `</details>`, or `null`.
 */
function extractChangesSection(commentBody: string): string | null {
  const startIdx = commentBody.indexOf(WALKTHROUGH_START);
  if (startIdx === -1) return null;

  const afterStart = commentBody.slice(startIdx);
  const changesIdx = afterStart.indexOf(CHANGES_HEADING);
  if (changesIdx === -1) return null;

  const afterChanges = afterStart.slice(changesIdx + CHANGES_HEADING.length);
  const nextHeading = NEXT_HEADING_RE.exec(afterChanges);
  const detailsEnd = afterChanges.indexOf('</details>');
  let endIdx = afterChanges.length;
  if (nextHeading) endIdx = Math.min(endIdx, nextHeading.index);
  if (detailsEnd !== -1) endIdx = Math.min(endIdx, detailsEnd);

  return afterChanges.slice(0, endIdx);
}

/**
 * Extracts backtick-delimited paths from a table cell.
 * @param cell - Raw markdown cell content.
 * @returns Array of normalized path strings.
 */
function extractPathsFromCell(cell: string): string[] {
  const paths: string[] = [];
  for (const match of cell.matchAll(/`([^`]+)`/g)) {
    const normalized = normalizePathGlob(match[1]);
    if (normalized.length > 0) paths.push(normalized);
  }
  return paths;
}

/**
 * Strips heavy markdown formatting (bold, HTML tags) from a summary cell.
 *
 * Preserves backtick-delimited code spans since they are useful in changelogs.
 * @param cell - Raw markdown cell content.
 * @returns Cleaned summary text.
 */
function cleanSummaryCell(cell: string): string {
  return cell
    .replace(/\*\*/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Parses the Changes table into per-row entries with paths and summaries.
 *
 * Each row in the Changes table maps file paths (left column) to a description
 * of what changed (right column). This function returns one entry per data row.
 * @param commentBody - Raw markdown body of the CodeRabbit comment.
 * @returns Array of change rows. Empty if no Changes section is found.
 */
export function parseCodeRabbitChanges(commentBody: string): CodeRabbitChangeRow[] {
  const section = extractChangesSection(commentBody);
  if (!section) return [];

  const rows: CodeRabbitChangeRow[] = [];
  let pastSeparator = false;

  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (line.startsWith('|---') || line.startsWith('| ---')) {
      pastSeparator = true;
      continue;
    }
    if (!pastSeparator) continue;

    const cells = line.split('|').slice(1, -1);
    if (cells.length < 2) continue;

    const paths = extractPathsFromCell(cells[0]);
    if (paths.length === 0) continue;

    const summary = cleanSummaryCell(cells[1]);
    if (summary.length === 0) continue;

    rows.push({ paths, summary });
  }

  return rows;
}

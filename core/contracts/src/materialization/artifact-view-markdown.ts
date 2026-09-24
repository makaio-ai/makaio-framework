/**
 * Surface-neutral Markdown renderer for {@link ArtifactViewModel}.
 *
 * Converts a validated view model into deterministic GitHub-flavored
 * Markdown that every Markdown-capable surface (issue bodies, wiki pages,
 * chat) can consume or convert further. The renderer is pure: it never
 * inspects Artifact data or provider planning — it renders only the
 * validated view model.
 *
 * All eight section variants are supported through a single render primitive.
 */

import type {
  ArtifactViewCodeSection,
  ArtifactViewDiagramSection,
  ArtifactViewEvidenceSection,
  ArtifactViewLink,
  ArtifactViewModel,
  ArtifactViewPropertiesSection,
  ArtifactViewRawSection,
  ArtifactViewRelationsSection,
  ArtifactViewSection,
  ArtifactViewSummarySection,
  ArtifactViewTableSection,
} from './view-model.js';

// ---------------------------------------------------------------------------
// Version constant
// ---------------------------------------------------------------------------

/**
 * Monotonically increasing renderer version.
 *
 * Bump this when the Markdown output format changes so that surfaces which
 * fingerprint rendered output can detect the need to re-render.
 */
export const ARTIFACT_VIEW_MARKDOWN_RENDERER_VERSION = 8;

/**
 * Options for {@link renderArtifactViewMarkdown}.
 */
export interface ArtifactViewMarkdownOptions {
  /**
   * Whether to emit the view title as a leading level-2 heading.
   *
   * Surfaces that already display the title outside the body (for example a
   * page title) pass `false` to avoid a duplicated heading. Defaults to `true`.
   */
  readonly includeTitle?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute a fence string that is safe for the given content.
 *
 * When the content itself contains triple backticks, the fence is extended
 * to one backtick longer than the longest consecutive run of backticks
 * found in the content.
 * @param content - Content that will be enclosed in the fence.
 * @returns A backtick fence string (at least 3 backticks).
 */
function computeFence(content: string): string {
  let maxRun = 0;
  let current = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '`') {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  const fenceLength = Math.max(3, maxRun + 1);
  return '`'.repeat(fenceLength);
}

/**
 * Sanitize a fenced code block info string.
 *
 * The CommonMark spec forbids backtick characters in backtick-fence info
 * strings. This helper strips them so that a malicious or unexpected
 * language token cannot break the fence boundary.
 * @param infoString - Raw info string (typically a language identifier).
 * @returns Sanitized info string safe for use after the opening fence.
 */
function sanitizeInfoString(infoString: string): string {
  return infoString.replace(/`/g, '');
}

/**
 * Escape a link label for Markdown link syntax.
 *
 * Backslash-escapes `]` characters so the label cannot break the
 * `[label](url)` syntax.
 * @param label - Raw link label text.
 * @returns Escaped label safe for use inside `[…]`.
 */
function escapeLinkLabel(label: string): string {
  return label.replace(/\]/g, '\\]');
}

/**
 * Encode source-part metadata for an inline Markdown label.
 *
 * The exact source identifier remains available on the view link. The rendered
 * form preserves every UTF-16 code unit while using only Markdown-neutral
 * characters, so Markdown cannot collapse or reinterpret it.
 * @param sourceLocalId - Raw local identifier from relation metadata.
 * @returns An injective, single-line source identifier suitable for a Markdown label.
 */
function encodeSourceLocalId(sourceLocalId: string): string {
  let encoded = '';
  for (let index = 0; index < sourceLocalId.length; index++) {
    const codeUnit = sourceLocalId.charCodeAt(index);
    const character = sourceLocalId[index];
    encoded +=
      (codeUnit >= 0x30 && codeUnit <= 0x39) ||
      (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
      (codeUnit >= 0x61 && codeUnit <= 0x7a) ||
      character === '-'
        ? character
        : `%${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}

/**
 * Escape a URL for Markdown link syntax.
 *
 * Percent-encodes literal parentheses so balanced and unbalanced URL text
 * cannot interfere with the surrounding `[label](url)` syntax.
 * @param url - Raw URL text.
 * @returns Escaped URL safe for use inside `(…)`.
 */
function escapeLinkUrl(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Render a navigation link as Markdown.
 *
 * Links with a URL produce `[label](url)`. Links with only an artifactId
 * render as plain text since there is no resolvable URL.
 *
 * The label is escaped for `]` and URL parentheses are percent-encoded so that
 * special characters in either cannot break Markdown link syntax.
 * @param link - Navigation link to render.
 * @returns Markdown link or plain label.
 */
function renderLink(link: ArtifactViewLink): string {
  const sourceLocalId = link.sourceLocalId ? encodeSourceLocalId(link.sourceLocalId) : undefined;
  const label = sourceLocalId ? `${link.label} (from part: ${sourceLocalId})` : link.label;
  if (link.url) {
    return `[${escapeLinkLabel(label)}](${escapeLinkUrl(link.url)})`;
  }
  if (sourceLocalId) {
    return `${link.label} (from part: ${escapeLinkLabel(sourceLocalId)})`;
  }
  return label;
}

/**
 * Render structured artifact navigation.
 *
 * Breadcrumbs retain their declared order in one compact trail. Related
 * artifacts render as a separate bullet list. Empty groups emit no Markdown.
 * Links without URLs degrade to their plain labels through {@link renderLink}.
 * @param navigation - Structured breadcrumb and related-link navigation.
 * @returns Markdown lines, or an empty array when navigation is empty.
 */
function renderNavigation(navigation: ArtifactViewModel['navigation']): string[] {
  const lines: string[] = [];

  if (navigation.breadcrumbs.length > 0) {
    lines.push(`**Breadcrumbs:** ${navigation.breadcrumbs.map(renderLink).join(' › ')}`);
  }

  if (navigation.related.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('**Related:**');
    for (const link of navigation.related) {
      lines.push(`- ${renderLink(link)}`);
    }
  }

  return lines;
}

/**
 * Escape a table cell value for safe embedding in a GFM table row.
 *
 * - Pipe characters (`|`) are backslash-escaped so they do not break
 *   column boundaries.
 * - Newlines (`\n`, `\r`) are replaced with a single space so each table
 *   row remains on one line (GFM does not support multi-line cells).
 * @param value - Raw cell value.
 * @returns Escaped cell value safe for inline table rendering.
 */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

/**
 * Render a summary section.
 * @param section - Summary section to render.
 * @returns Markdown lines for the summary.
 */
function renderSummarySection(section: ArtifactViewSummarySection): string[] {
  return [`### ${section.title}`, '', section.text];
}

/**
 * Render a properties section.
 * @param section - Properties section to render.
 * @returns Markdown lines for the properties.
 */
function renderPropertiesSection(section: ArtifactViewPropertiesSection): string[] {
  const lines: string[] = [`### ${section.title}`, ''];
  for (const row of section.rows) {
    if (row.value.length > 0) {
      lines.push(`**${row.label}:** ${row.value}`);
    } else {
      lines.push(`**${row.label}:**`);
    }
  }
  return lines;
}

/**
 * Render a table section.
 *
 * Column alignment strategy:
 * - If any row carries a `link`, an extra column (empty header) is appended
 *   to the header and the rendered link is placed in that column for every
 *   row that has one.
 * - Rows shorter than the header are padded with empty cells.
 * - All cell values (including rendered links) are passed through
 *   {@link escapeTableCell}. Header columns are pipe-escaped.
 * @param section - Table section to render.
 * @returns Markdown lines for the table.
 */
function renderTableSection(section: ArtifactViewTableSection): string[] {
  const lines: string[] = [`### ${section.title}`, ''];

  // Pre-scan: does any row carry a link?
  const hasAnyLink = section.rows.some((r) => r.link !== undefined);

  // Build escaped header columns; add a link column if needed.
  const headers = section.columns.map(escapeTableCell);
  if (hasAnyLink) {
    headers.push('');
  }
  const columnCount = headers.length;

  // Render header + separator
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

  // Data rows
  for (const row of section.rows) {
    const cells = row.cells.map(escapeTableCell);

    // Place rendered link in the link column (if any row has links)
    if (hasAnyLink) {
      cells.push(row.link ? escapeTableCell(renderLink(row.link)) : '');
    }

    // Pad short rows to column width
    while (cells.length < columnCount) {
      cells.push('');
    }

    lines.push(`| ${cells.join(' | ')} |`);
  }

  return lines;
}

/**
 * Render a relations section.
 * @param section - Relations section to render.
 * @returns Markdown lines for the relations.
 */
function renderRelationsSection(section: ArtifactViewRelationsSection): string[] {
  const lines: string[] = [`### ${section.title}`, ''];

  for (const group of section.groups) {
    lines.push(`**${group.type}**`, '');
    for (const item of group.items) {
      lines.push(`- ${renderLink(item)}`);
    }
    lines.push('');
  }

  return lines;
}

/**
 * Render an evidence section.
 * @param section - Evidence section to render.
 * @returns Markdown lines for the evidence.
 */
function renderEvidenceSection(section: ArtifactViewEvidenceSection): string[] {
  const lines: string[] = [`### ${section.title}`, ''];

  for (const item of section.items) {
    const locatorSuffix = item.locator ? ` (${item.locator})` : '';
    lines.push(`- **${item.kind}:** ${item.id}${locatorSuffix}`);
  }

  return lines;
}

/**
 * Render a fenced section.
 * @param title - Section heading.
 * @param content - Content enclosed by the fence.
 * @param infoString - Code-fence info string.
 * @returns Markdown lines for the fenced section.
 */
function renderFencedSection(title: string, content: string, infoString: string): string[] {
  const fence = computeFence(content);
  return [`### ${title}`, '', `${fence}${sanitizeInfoString(infoString)}`, content, fence];
}

/**
 * Render a raw JSON section.
 * @param section - Raw section to render.
 * @returns Markdown lines for the raw JSON.
 */
function renderRawSection(section: ArtifactViewRawSection): string[] {
  return renderFencedSection(section.title, JSON.stringify(section.json, null, 2), 'json');
}

/**
 * Render a code section.
 * @param section - Code section to render.
 * @returns Markdown lines for the code.
 */
function renderCodeSection(section: ArtifactViewCodeSection): string[] {
  return renderFencedSection(section.title, section.content, section.language);
}

/**
 * Render a diagram section.
 * @param section - Diagram section to render.
 * @returns Markdown lines for the diagram.
 */
function renderDiagramSection(section: ArtifactViewDiagramSection): string[] {
  return renderFencedSection(section.title, section.source, section.notation);
}

/**
 * Dispatch a section to its type-specific renderer.
 * @param section - Section to render.
 * @returns Markdown lines for the section.
 */
function renderSection(section: ArtifactViewSection): string[] {
  switch (section.type) {
    case 'summary':
      return renderSummarySection(section);
    case 'properties':
      return renderPropertiesSection(section);
    case 'table':
      return renderTableSection(section);
    case 'relations':
      return renderRelationsSection(section);
    case 'evidence':
      return renderEvidenceSection(section);
    case 'raw':
      return renderRawSection(section);
    case 'code':
      return renderCodeSection(section);
    case 'diagram':
      return renderDiagramSection(section);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render an artifact view model as GitHub-flavored Markdown.
 *
 * The renderer is pure and deterministic: identical view models always produce
 * identical Markdown output. It never inspects Artifact data or provider
 * planning — only the validated {@link ArtifactViewModel} is consumed.
 *
 * Section variants are dispatched by their `type` discriminant. Fenced code
 * blocks dynamically extend the fence length when the content itself contains
 * backtick runs.
 * @param view - Validated artifact view model.
 * @param options - Rendering options; see {@link ArtifactViewMarkdownOptions}.
 * @returns Complete Markdown document.
 */
export function renderArtifactViewMarkdown(view: ArtifactViewModel, options: ArtifactViewMarkdownOptions = {}): string {
  const blocks: string[][] = [];

  if (options.includeTitle !== false) {
    blocks.push([`## ${view.title}`]);
  }

  const navigationLines = renderNavigation(view.navigation);
  if (navigationLines.length > 0) {
    blocks.push(navigationLines);
  }

  for (const section of view.sections) {
    blocks.push(renderSection(section));
  }

  return blocks.map((lines) => lines.join('\n')).join('\n\n');
}

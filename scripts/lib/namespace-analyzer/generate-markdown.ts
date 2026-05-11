import { relativeSourcePath } from './path-utils.js';
import type { AnalysisResult, NamespaceEntry, SubjectEntry, SubjectField } from './types.js';

interface GeneratedFile {
  /** Relative path within the output directory. */
  path: string;
  content: string;
}

export interface MarkdownGenerationOptions {
  /** Root README title. */
  title: string;
  /** Generated documentation root relative to the current distribution root. */
  docsRoot: string;
  /** Source path root relative to the current distribution root. */
  sourceRoot: string;
  /** Optional namespace tiers to include. Omit to include every namespace in the analysis. */
  includeTiers?: readonly NamespaceEntry['tier'][];
  /** Whether product callsites should be rendered. */
  includeProductCallsites: boolean;
  /**
   * When set, source-file links become absolute URLs under this base
   * (e.g. `https://github.com/org/repo/blob/<commit>`).
   * When omitted, source links remain relative from the doc file.
   */
  sourceBaseUrl?: string;
  /** When true, each file is prepended with Starlight-compatible YAML frontmatter. */
  frontmatter?: boolean;
  /** File name for directory index pages. Defaults to `'README.md'`. */
  indexFileName?: string;
}

/**
 * Generates Markdown documentation from analyzed namespace data.
 * One file per namespace, routed into subdirectories by package prefix.
 * Each subdirectory and the root get a README.md index.
 * @param analysis - The full analysis result from the analyzer.
 * @param options - Markdown rendering options, including explicit path roots.
 * @returns Array of generated files with relative paths and content.
 */
export function generateMarkdown(analysis: AnalysisResult, options: MarkdownGenerationOptions): GeneratedFile[] {
  const includeTiers = options.includeTiers ? new Set(options.includeTiers) : null;
  const namespaces = includeTiers ? analysis.namespaces.filter((ns) => includeTiers.has(ns.tier)) : analysis.namespaces;
  const indexFile = options.indexFileName ?? 'README.md';

  const files: GeneratedFile[] = [];
  const byDir = new Map<string, { ns: NamespaceEntry; path: string }[]>();

  for (const ns of namespaces) {
    const filePath = namespaceToFilePath(ns);
    files.push({
      path: `${filePath}.md`,
      content: wrapContent(renderNamespaceFile(ns, filePath, options), options),
    });

    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.';
    const existing = byDir.get(dir) ?? [];
    existing.push({ ns, path: filePath });
    byDir.set(dir, existing);
  }

  // Root index
  files.push({
    path: indexFile,
    content: wrapContent(renderRootIndex(namespaces, byDir, options.title, indexFile), options),
  });

  // Subdirectory indexes
  for (const [dir, entries] of byDir) {
    if (dir === '.') continue;
    files.push({
      path: `${dir}/${indexFile}`,
      content: wrapContent(renderDirIndex(dir, entries), options),
    });
  }

  return files;
}

/**
 * Extracts a Starlight page title from the first Markdown heading.
 * @param content - Markdown body to scan.
 * @param fallback - Fallback title when no heading is found.
 * @returns Extracted or fallback title with inline formatting stripped.
 */
function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.replace(/[`*]/g, '') ?? fallback;
}

/**
 * Prepends Starlight YAML frontmatter when the `frontmatter` option is enabled.
 * @param content - Raw Markdown body.
 * @param options - Generation options controlling frontmatter emission.
 * @returns Markdown content, optionally prefixed with frontmatter.
 */
function wrapContent(content: string, options: MarkdownGenerationOptions): string {
  if (!options.frontmatter) return content;
  const title = extractTitle(content, 'Bus Subjects');
  return `---\ntitle: ${JSON.stringify(title)}\neditUrl: false\nprev: false\nnext: false\n---\n\n${content}`;
}

/** Prefix routing rules for nested folder structure. Order matters — first match wins. */
const PACKAGE_ROUTES: readonly { prefix: string; dir: string; strip: string }[] = [
  { prefix: '@makaio/ai-adapters-', dir: 'adapters', strip: '@makaio/ai-adapters-' },
  { prefix: '@makaio/extension-', dir: 'extensions', strip: '@makaio/extension-' },
  { prefix: '@makaio/client-', dir: 'clients', strip: '@makaio/client-' },
  { prefix: '@makaio/clients-', dir: 'clients', strip: '@makaio/clients-' },
  { prefix: '@makaio/services-', dir: 'services', strip: '@makaio/services-' },
  { prefix: '@makaio/tools-', dir: 'tools', strip: '@makaio/tools-' },
  { prefix: '@makaio/ui-', dir: 'ui', strip: '@makaio/ui-' },
];

/**
 * Derives a relative file path for a namespace using its package for directory routing
 * and its prefix for the filename.
 * @param ns - The namespace entry to route.
 * @returns Relative path without extension, e.g. `extensions/terminal` or `agent`.
 */
function namespaceToFilePath(ns: NamespaceEntry): string {
  const pkg = ns.definedIn.package ?? ns.definedIn.file;
  const slug = sanitizeSlug(ns.prefix);

  for (const route of PACKAGE_ROUTES) {
    if (pkg.startsWith(route.prefix)) {
      return `${route.dir}/${slug}`;
    }
  }

  return slug;
}

/**
 * Sanitizes a string into a URL/filesystem-safe slug.
 * @param name - Raw name segment to sanitize.
 * @returns Lowercase slug with only alphanumeric characters and hyphens.
 */
function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Formats a clickable link to the schema source file for a subject.
 * Returns '—' when the schema is defined in the same file as the namespace.
 * @param subject - The subject entry.
 * @param docFilePath - The doc file path (without .md) for relative link computation.
 * @param options - Markdown rendering options with explicit path roots.
 * @returns Markdown link or dash.
 */
function formatSchemaLink(subject: SubjectEntry, docFilePath: string, options: MarkdownGenerationOptions): string {
  if (!subject.schemaFile) return '—';
  const filename = subject.schemaFile.split('/').pop()!;
  const link = resolveSourceLink(docFilePath, subject.schemaFile, options);
  return `[\`${filename}\`](${link})`;
}

/**
 * Renders a Markdown field table from an array of subject fields.
 * @param fields - The fields to render as table rows.
 * @returns Array of Markdown lines for the table (no trailing blank line).
 */
function renderFieldTable(fields: SubjectField[]): string[] {
  if (fields.length === 0) {
    return ['_Empty object._'];
  }

  const lines: string[] = ['| Field | Type | Required |', '|-------|------|----------|'];

  for (const field of fields) {
    const required = field.required ? 'yes' : 'no';
    // Keep analyzer type strings verbatim. The linked schema source is the
    // canonical expansion point for complex reusable and discriminated types.
    // Escape pipe characters inside type strings to avoid breaking the table.
    const escapedType = field.type.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    lines.push(`| \`${field.name}\` | \`${escapedType}\` | ${required} |`);
  }

  return lines;
}

/**
 * Converts TSDoc inline tags that do not render in Markdown into readable text.
 * @param description - Extracted TSDoc/JSDoc description.
 * @returns Markdown-safe description text.
 */
function normalizeDescription(description: string): string {
  return description.replace(/\{@link\s+([^}\s]+)(?:\s+[^}]*)?\s*\}/g, '`$1`');
}

/**
 * Renders per-subject detail sections with field tables for a namespace.
 *
 * Only subjects with descriptions or at least one extracted field array are
 * rendered. The summary table above already lists the remaining subjects.
 * @param subjects - All subjects of the namespace.
 * @param lines - The output lines array to append to.
 */
function renderSubjectDetails(subjects: SubjectEntry[], lines: string[]): void {
  const withFields = subjects.filter(
    (s) =>
      s.description !== undefined ||
      s.payload !== undefined ||
      s.request !== undefined ||
      s.response !== undefined ||
      s.schemaFile !== undefined,
  );

  if (withFields.length === 0) return;

  lines.push('## Subject Details', '');

  for (const subject of withFields) {
    lines.push(`### <a id="${subject.wire}"></a>\`${subject.wire}\` (${subject.type})`, '');

    if (subject.description) {
      lines.push(normalizeDescription(subject.description), '');
    }

    const hasSubjectLine = subject.description?.includes('Subject:') ?? false;
    const hasTypeLine = subject.description?.includes('Type:') ?? false;

    if (!hasSubjectLine) {
      lines.push(`Subject: \`${subject.wire}\``);
    }
    if (!hasTypeLine) {
      lines.push(`Type: ${subject.type === 'rpc' ? 'Request (RPC)' : 'Event'}`);
    }
    if (!hasSubjectLine || !hasTypeLine) {
      lines.push('');
    }

    if (subject.type === 'event' && subject.payload !== undefined) {
      lines.push(...renderFieldTable(subject.payload), '');
    } else if (subject.type === 'rpc') {
      if (subject.request !== undefined) {
        lines.push('**Request:**', '', ...renderFieldTable(subject.request), '');
      }
      if (subject.response !== undefined) {
        lines.push('**Response:**', '', ...renderFieldTable(subject.response), '');
      }
    }
  }
}

/**
 * Computes a link from a doc file to a source file.
 * When `sourceBaseUrl` is set, returns an absolute URL; otherwise a relative path.
 * @param docFilePath - Path of the generated doc file relative to output dir (e.g. `adapters/anthropic-sdk`).
 * @param sourceFile - Path of the source file relative to the active source root.
 * @param options - Markdown rendering options with explicit path roots.
 * @returns Absolute URL or relative path from the doc file to the source file.
 */
function resolveSourceLink(docFilePath: string, sourceFile: string, options: MarkdownGenerationOptions): string {
  if (options.sourceBaseUrl) {
    const base = options.sourceBaseUrl.replace(/\/+$/, '');
    const normalizedSource = sourceFile.replace(/\\/g, '/').replace(/^\/+/, '');
    return `${base}/${normalizedSource}`;
  }
  return relativeSourcePath(docFilePath, sourceFile, options.docsRoot, options.sourceRoot);
}

/**
 * Renders a single namespace documentation file.
 * @param ns - The namespace entry to render.
 * @param docFilePath - Relative path of this doc file within the output dir (without .md).
 * @param options - Markdown rendering options.
 * @returns Complete Markdown content for the file.
 */
function renderNamespaceFile(ns: NamespaceEntry, docFilePath: string, options: MarkdownGenerationOptions): string {
  const sourceLink = resolveSourceLink(docFilePath, ns.definedIn.file, options);

  const lines: string[] = [
    `# \`${ns.prefix}\``,
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| Prefix | \`${ns.prefix}\` |`,
    `| Namespace constant | \`${ns.namespaceConstant}\` |`,
  ];

  if (ns.subjectsConstant) {
    lines.push(`| Subjects constant | \`${ns.subjectsConstant}\` |`);
  }

  lines.push(
    `| Kind | ${ns.kind} |`,
    `| Schema record | \`${ns.schemaRecordName}\` |`,
    `| Tier | ${ns.tier} |`,
    `| Package | \`${ns.definedIn.package ?? '—'}\` |`,
    `| Defined in | [\`${ns.definedIn.file}\`](${sourceLink}) |`,
    '',
  );

  if (ns.subjects.length > 0) {
    lines.push('## Subjects', '', '| Key | Wire | Type | Schema |', '|-----|------|------|--------|');

    for (const subject of ns.subjects) {
      const hasDetails =
        subject.description !== undefined ||
        subject.payload !== undefined ||
        subject.request !== undefined ||
        subject.response !== undefined ||
        subject.schemaFile !== undefined;
      const wireCell = hasDetails ? `[\`${subject.wire}\`](#${subject.wire})` : `\`${subject.wire}\``;
      const schemaCell = ` ${formatSchemaLink(subject, docFilePath, options)} |`;
      lines.push(`| \`${subject.key}\` | ${wireCell} | ${subject.type} |${schemaCell}`);
    }

    lines.push('');

    renderSubjectDetails(ns.subjects, lines);
  }

  const fwCallsites = ns.callsites.framework;
  const prodCallsites = options.includeProductCallsites ? ns.callsites.product : [];
  const totalCallsites = fwCallsites.length + prodCallsites.length;

  if (totalCallsites > 0) {
    lines.push('## Callsites', '');

    if (fwCallsites.length > 0) {
      lines.push('**Framework:**', '');
      for (const cs of fwCallsites) {
        lines.push(`- \`${cs}\``);
      }
      lines.push('');
    }

    if (prodCallsites.length > 0) {
      lines.push('**Product:**', '');
      for (const cs of prodCallsites) {
        lines.push(`- \`${cs}\``);
      }
      lines.push('');
    }
  }

  lines.push('---', '', '*Auto-generated by `yarn docs:bus`. Do not edit manually.*', '');

  return lines.join('\n');
}

/**
 * Renders the root README.md with summary stats, directory links, and root-level namespaces.
 * @param namespaces - All namespaces in this view.
 * @param byDir - Namespaces grouped by output directory.
 * @param title - Root README title.
 * @param indexFile - File name for directory index pages.
 * @returns Complete Markdown content for the root index.
 */
function renderRootIndex(
  namespaces: NamespaceEntry[],
  byDir: Map<string, { ns: NamespaceEntry; path: string }[]>,
  title: string,
  indexFile: string = 'README.md',
): string {
  const tiers = countByTier(namespaces);
  const totalSubjects = namespaces.reduce((sum, ns) => sum + ns.subjects.length, 0);
  const events = namespaces.reduce((sum, ns) => sum + ns.subjects.filter((s) => s.type === 'event').length, 0);
  const rpcs = totalSubjects - events;

  const lines: string[] = [
    `# ${title}`,
    '',
    '## Summary',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Namespaces | ${String(namespaces.length)} |`,
    `| Subjects | ${String(totalSubjects)} (${String(events)} events, ${String(rpcs)} RPCs) |`,
  ];

  for (const [tier, count] of Object.entries(tiers)) {
    if (count > 0) {
      lines.push(`| ${tier} | ${String(count)} |`);
    }
  }

  const kinds = countByKind(namespaces);
  for (const [kind, count] of Object.entries(kinds)) {
    if (count > 0) {
      lines.push(`| kind: ${kind} | ${String(count)} |`);
    }
  }

  // Directory listing
  const dirs = [...byDir.keys()].filter((d) => d !== '.').sort();
  if (dirs.length > 0) {
    lines.push('', '## Directories', '');
    lines.push('| Directory | Namespaces | Subjects |');
    lines.push('|-----------|-----------|----------|');
    for (const dir of dirs) {
      const entries = byDir.get(dir)!;
      const subjectCount = entries.reduce((sum, e) => sum + e.ns.subjects.length, 0);
      lines.push(`| [${dir}/](./${dir}/${indexFile}) | ${String(entries.length)} | ${String(subjectCount)} |`);
    }
  }

  // Root-level namespaces
  const rootEntries = byDir.get('.') ?? [];
  if (rootEntries.length > 0) {
    lines.push('', '## Core Namespaces', '');
    lines.push('| Prefix | Kind | Subjects | Type Breakdown |');
    lines.push('|--------|------|----------|----------------|');

    for (const { ns, path } of rootEntries) {
      const evCount = ns.subjects.filter((s) => s.type === 'event').length;
      const rpcCount = ns.subjects.filter((s) => s.type === 'rpc').length;
      const breakdown = ns.subjects.length > 0 ? `${String(evCount)}E / ${String(rpcCount)}R` : '—';
      lines.push(`| [\`${ns.prefix}\`](./${path}.md) | ${ns.kind} | ${String(ns.subjects.length)} | ${breakdown} |`);
    }
  }

  lines.push('', '---', '', '*Auto-generated by `yarn docs:bus`. Do not edit manually.*', '');

  return lines.join('\n');
}

/**
 * Renders a subdirectory README.md listing all namespaces in that directory.
 * @param dir - Directory name (e.g. 'adapters', 'extensions').
 * @param entries - Namespace entries routed to this directory.
 * @returns Complete Markdown content for the directory index.
 */
function renderDirIndex(dir: string, entries: { ns: NamespaceEntry; path: string }[]): string {
  const totalSubjects = entries.reduce((sum, e) => sum + e.ns.subjects.length, 0);
  const events = entries.reduce((sum, e) => sum + e.ns.subjects.filter((s) => s.type === 'event').length, 0);
  const rpcs = totalSubjects - events;

  const lines: string[] = [
    `# ${dir}`,
    '',
    `${formatCount(entries.length, 'namespace')}, ${formatCount(totalSubjects, 'subject')} (${formatCount(events, 'event')}, ${String(rpcs)} RPCs).`,
    '',
    '| Prefix | Kind | Subjects | Type Breakdown |',
    '|--------|------|----------|----------------|',
  ];

  for (const { ns, path } of entries) {
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const evCount = ns.subjects.filter((s) => s.type === 'event').length;
    const rpcCount = ns.subjects.filter((s) => s.type === 'rpc').length;
    const breakdown = ns.subjects.length > 0 ? `${String(evCount)}E / ${String(rpcCount)}R` : '—';
    lines.push(`| [\`${ns.prefix}\`](./${filename}.md) | ${ns.kind} | ${String(ns.subjects.length)} | ${breakdown} |`);
  }

  lines.push('', '---', '', '*Auto-generated by `yarn docs:bus`. Do not edit manually.*', '');

  return lines.join('\n');
}

/**
 * Format a count with a singular or plural noun.
 * @param count - Numeric count to render.
 * @param noun - Singular noun for the counted item.
 * @returns Count followed by the correctly inflected noun.
 */
function formatCount(count: number, noun: string): string {
  return `${String(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * Counts namespaces by tier.
 * @param namespaces - Namespace entries to count.
 * @returns Object with tier names as keys and counts as values.
 */
function countByTier(namespaces: NamespaceEntry[]): Record<string, number> {
  const tiers: Record<string, number> = {};
  for (const ns of namespaces) {
    tiers[ns.tier] = (tiers[ns.tier] ?? 0) + 1;
  }
  return tiers;
}

/**
 * Counts namespaces by registration kind.
 * @param namespaces - Namespace entries to count.
 * @returns Object with kind values as keys and counts as values.
 */
function countByKind(namespaces: NamespaceEntry[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const ns of namespaces) {
    kinds[ns.kind] = (kinds[ns.kind] ?? 0) + 1;
  }
  return kinds;
}

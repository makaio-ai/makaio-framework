/**
 * Invariant checker for the package inventory in `docs/package-overview.md`.
 *
 * The package overview is an LLM navigation map, so it must stay in lockstep
 * with the Yarn workspace inventory.
 * @packageDocumentation
 */

import { minimatch } from 'minimatch';

/** A Yarn workspace entry relevant to the package overview. */
export interface WorkspaceEntry {
  readonly location: string;
  readonly name: string;
}

/** A raw non-root Yarn inventory entry before manifest scoping. */
export interface YarnWorkspaceEntry {
  readonly location: string;
  readonly name: string | null;
}

/** A package inventory row parsed from `docs/package-overview.md`. */
export interface PackageOverviewEntry {
  readonly location: string;
  readonly name: string;
}

/** A validated package overview drift finding. */
export interface PackageOverviewIssue {
  readonly kind: 'missing-package' | 'extra-package' | 'package-name-mismatch' | 'duplicate-package';
  readonly message: string;
}

/** Result returned by {@link checkPackageOverview}. */
export interface PackageOverviewResult {
  readonly issues: readonly PackageOverviewIssue[];
  readonly ok: boolean;
}

interface CheckPackageOverviewOptions {
  readonly markdown: string;
  readonly workspaces: readonly WorkspaceEntry[];
}

interface WorkspaceJsonLine {
  readonly location: string;
  readonly name: string | null;
}

/**
 * Parses the JSONL output of `yarn workspaces list --json`.
 * @param output - Raw JSONL command output.
 * @returns Non-root workspace entries.
 */
export function parseYarnWorkspacesList(output: string): YarnWorkspaceEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseWorkspaceJsonLine)
    .filter((workspace): workspace is YarnWorkspaceEntry => workspace !== undefined);
}

/**
 * Scope an enclosing Yarn project's workspace inventory to a nested logical root.
 * @param workspaces - Workspace entries relative to the active Yarn project.
 * @param rootLocation - Logical root relative to that project, or `.` when they are identical.
 * @returns Entries beneath the logical root with that prefix removed.
 */
export function scopeWorkspacesToRoot(
  workspaces: readonly YarnWorkspaceEntry[],
  rootLocation: string,
): YarnWorkspaceEntry[] {
  if (rootLocation === '.') return [...workspaces];

  const prefix = `${rootLocation}/`;
  return workspaces
    .filter((workspace) => workspace.location.startsWith(prefix))
    .map((workspace) => ({ ...workspace, location: workspace.location.slice(prefix.length) }));
}

/**
 * Retain only workspaces declared by a logical root's own workspace patterns.
 * @param workspaces - Workspace entries relative to the logical root.
 * @param patterns - Yarn workspace patterns from that root's package manifest.
 * @returns Entries matched by an include pattern and no exclusion pattern.
 */
export function filterDeclaredWorkspaces(
  workspaces: readonly YarnWorkspaceEntry[],
  patterns: readonly string[],
): WorkspaceEntry[] {
  const includes = patterns.filter((pattern) => !pattern.startsWith('!'));
  const excludes = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
  return workspaces
    .filter(
      (workspace) =>
        includes.some((pattern) => minimatch(workspace.location, pattern)) &&
        !excludes.some((pattern) => minimatch(workspace.location, pattern)),
    )
    .map((workspace) => {
      if (workspace.name === null) {
        throw new Error(`Declared Yarn workspace "${workspace.location}" has no package name`);
      }
      return { location: workspace.location, name: workspace.name };
    });
}

/**
 * Parses package inventory rows from Markdown tables whose header is
 * `Path | Package | Description`.
 * @param markdown - Raw Markdown content from `docs/package-overview.md`.
 * @returns Parsed package entries in document order.
 */
export function parsePackageOverviewEntries(markdown: string): PackageOverviewEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: PackageOverviewEntry[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isPackageTableHeader(lines[index])) continue;

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = lines[rowIndex];
      if (!row.trim().startsWith('|')) break;

      const entry = parsePackageTableRow(row);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  return entries;
}

/**
 * Checks that `docs/package-overview.md` exactly matches Yarn workspaces.
 * @param options - Markdown content and workspace entries to compare.
 * @returns Structured result with all discovered drift issues.
 */
export function checkPackageOverview(options: CheckPackageOverviewOptions): PackageOverviewResult {
  const entries = parsePackageOverviewEntries(options.markdown);
  const workspacesByLocation = new Map(options.workspaces.map((workspace) => [workspace.location, workspace]));
  const entriesByLocation = new Map<string, PackageOverviewEntry[]>();
  const issues: PackageOverviewIssue[] = [];

  for (const entry of entries) {
    const existing = entriesByLocation.get(entry.location) ?? [];
    existing.push(entry);
    entriesByLocation.set(entry.location, existing);
  }

  for (const workspace of options.workspaces) {
    if (!entriesByLocation.has(workspace.location)) {
      issues.push({
        kind: 'missing-package',
        message: `Workspace "${workspace.location}" (${workspace.name}) is missing from docs/package-overview.md`,
      });
    }
  }

  for (const entry of entries) {
    const workspace = workspacesByLocation.get(entry.location);
    if (!workspace) {
      issues.push({
        kind: 'extra-package',
        message: `docs/package-overview.md lists "${entry.location}" (${entry.name}), but that location is not a Yarn workspace`,
      });
      continue;
    }

    if (entry.name !== workspace.name) {
      issues.push({
        kind: 'package-name-mismatch',
        message: `docs/package-overview.md lists "${entry.location}" as "${entry.name}", but the workspace name is "${workspace.name}"`,
      });
    }
  }

  for (const [location, duplicatedEntries] of entriesByLocation) {
    if (duplicatedEntries.length > 1) {
      issues.push({
        kind: 'duplicate-package',
        message: `docs/package-overview.md lists "${location}" ${duplicatedEntries.length} times`,
      });
    }
  }

  return { issues, ok: issues.length === 0 };
}

/**
 * Parses a single JSONL workspace record.
 * @param line - One JSON object from Yarn's JSONL output.
 * @returns Parsed workspace entry.
 */
function parseWorkspaceJsonLine(line: string): YarnWorkspaceEntry | undefined {
  const parsed = JSON.parse(line) as unknown;
  if (isRootWorkspaceJsonLine(parsed)) return undefined;
  if (!isWorkspaceJsonLine(parsed)) {
    throw new Error(`Invalid yarn workspaces list --json line: ${line}`);
  }
  return { location: parsed.location, name: parsed.name };
}

/**
 * Recognize the Yarn project root, which is not a documented package entry.
 * @param value - Parsed JSON value.
 * @returns Whether the value describes the project root.
 */
function isRootWorkspaceJsonLine(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as Record<string, unknown>)['location'] === '.';
}

/**
 * Type guard for Yarn workspace JSON records.
 * @param value - Parsed JSON value.
 * @returns Whether the value has the expected workspace record shape.
 */
function isWorkspaceJsonLine(value: unknown): value is WorkspaceJsonLine {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.location === 'string' && (typeof record.name === 'string' || record.name === null);
}

/**
 * Checks whether a Markdown table row is the package inventory header.
 * @param line - Markdown line to inspect.
 * @returns Whether the line is a package inventory table header.
 */
function isPackageTableHeader(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 3 && cells[0] === 'Path' && cells[1] === 'Package' && cells[2] === 'Description';
}

/**
 * Parses a package inventory table row.
 * @param row - Markdown table row.
 * @returns Package entry when the row contains path and package code spans.
 */
function parsePackageTableRow(row: string): PackageOverviewEntry | undefined {
  const cells = splitMarkdownTableRow(row);
  if (cells.length < 2) return undefined;

  const location = parseSingleCodeSpan(cells[0]);
  const name = parseSingleCodeSpan(cells[1]);
  if (!location || !name) return undefined;

  return { location, name };
}

/**
 * Splits a simple Markdown table row into trimmed cells.
 * @param row - Markdown table row.
 * @returns Cell contents without outer table pipes.
 */
function splitMarkdownTableRow(row: string): string[] {
  const trimmed = row.trim();
  if (!trimmed.startsWith('|')) return [];
  const withoutLeading = trimmed.slice(1);
  const withoutOuterPipes = withoutLeading.endsWith('|') ? withoutLeading.slice(0, -1) : withoutLeading;
  return withoutOuterPipes.split('|').map((cell) => cell.trim());
}

/**
 * Parses a table cell that contains one Markdown code span.
 * @param cell - Table cell content.
 * @returns The code span content when present.
 */
function parseSingleCodeSpan(cell: string): string | undefined {
  const match = /^`([^`]+)`$/.exec(cell);
  return match?.[1];
}

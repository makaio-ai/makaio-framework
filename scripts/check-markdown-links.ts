#!/usr/bin/env tsx
/**
 * Validate local Markdown links.
 *
 * The checker mirrors the docs site's common relative-link resolution:
 * direct paths, extensionless `.md` targets, and directory `index.md` targets
 * are all accepted.
 * @example
 * ```bash
 * yarn docs:links --changed
 * yarn docs:links --all
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, join } from 'node:path';

type ScanMode = 'changed' | 'all';

interface ParsedCliArgs {
  /** File selection mode. */
  mode: ScanMode;
  /** Repository root to scan from. */
  root: string;
  /** Optional file or directory paths limiting the scan. */
  scanPaths: string[];
}

interface CollectMarkdownFilesOptions {
  /** File selection mode. */
  mode: ScanMode;
  /** Repository root to scan from. */
  root: string;
  /** Optional file or directory paths limiting the scan. */
  scanPaths?: string[];
  /** Git file-list provider. */
  listGitFiles: (args: string[]) => string;
  /** Recursive all-file provider. */
  listAllFiles: (root: string) => string[];
}

interface MarkdownLink {
  /** Markdown file containing the link, relative to root. */
  sourceFile: string;
  /** Original link target as written in Markdown. */
  target: string;
  /** One-based line number for the link. */
  line: number;
}

interface MarkdownLinkCheckResult {
  /** Number of Markdown files scanned. */
  checkedFileCount: number;
  /** Missing local link targets. */
  missingLinks: MarkdownLink[];
}

const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*]\((<[^>]+>|[^)\n]+)\)/g;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Parse CLI arguments for the Markdown link checker.
 * @param args - Raw CLI arguments after the script name
 * @param cwd - Current working directory
 * @returns Parsed arguments
 */
export function parseCliArgs(args: string[], cwd: string = process.cwd()): ParsedCliArgs {
  const all = args.includes('--all');
  const changed = args.includes('--changed');
  const help = args.includes('--help') || args.includes('-h');
  const scanPathArgs: string[] = [];

  if (help) {
    return { mode: changed ? 'changed' : 'all', root: cwd, scanPaths: [] };
  }

  if (all && changed) {
    throw new Error('Use either --changed or --all, not both.');
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--all' || arg === '--changed') {
      continue;
    }
    if (arg === '--path') {
      const nextArg = args[index + 1];
      if (!nextArg) {
        throw new Error('--path requires a file or directory path.');
      }
      scanPathArgs.push(nextArg);
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    scanPathArgs.push(arg);
  }

  return {
    mode: all ? 'all' : 'changed',
    root: cwd,
    scanPaths: normalizeScanPaths(cwd, scanPathArgs),
  };
}

/**
 * Extract the URL/path portion from a Markdown link destination.
 * @param raw - Raw destination inside parentheses
 * @returns Link target without optional title text
 */
export function parseMarkdownLinkTarget(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) {
    const closingIndex = trimmed.indexOf('>');
    return closingIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, closingIndex);
  }
  return trimmed.split(/\s+/)[0] ?? '';
}

/**
 * Resolve a local Markdown target using docs-friendly fallbacks.
 * @param root - Repository root
 * @param sourceFile - Source Markdown file relative to root
 * @param target - Link target as written in Markdown
 * @returns Existing absolute path, or null when unresolved
 */
export function resolveLocalMarkdownTarget(root: string, sourceFile: string, target: string): string | null {
  const withoutAnchor = target.split('#')[0] ?? '';
  const withoutQuery = withoutAnchor.split('?')[0] ?? '';
  if (!withoutQuery || withoutQuery.startsWith('/')) {
    return null;
  }

  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(withoutQuery);
  } catch {
    decodedTarget = withoutQuery;
  }
  const basePath = resolve(root, dirname(sourceFile), decodedTarget);
  const candidates = [basePath, `${basePath}.md`, join(basePath, 'index.md'), join(basePath, 'README.md')];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Collect Markdown files for a scan.
 * @param options - File collection options and providers
 * @returns Sorted Markdown file paths relative to root
 */
export function collectMarkdownFiles(options: CollectMarkdownFilesOptions): string[] {
  const files =
    options.mode === 'all'
      ? options.listAllFiles(options.root)
      : [
          ...parseGitFileList(options.listGitFiles(['diff', '--name-only', '--diff-filter=ACMR', '--', '*.md'])),
          ...parseGitFileList(
            options.listGitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', '*.md']),
          ),
          ...parseGitFileList(options.listGitFiles(['ls-files', '--others', '--exclude-standard', '--', '*.md'])),
        ];

  return [
    ...new Set(
      files.filter((file) => file.endsWith('.md')).filter((file) => isWithinScanPaths(file, options.scanPaths ?? [])),
    ),
  ].sort();
}

/**
 * Check local Markdown links in selected files.
 * @param root - Repository root
 * @param files - Markdown files relative to root
 * @returns Link check result
 */
export function checkMarkdownLinks(root: string, files: string[]): MarkdownLinkCheckResult {
  const missingLinks: MarkdownLink[] = [];

  for (const sourceFile of files) {
    const absoluteSourceFile = resolve(root, sourceFile);
    const text = readFileSync(absoluteSourceFile, 'utf8');
    const lineStarts = collectLineStarts(text);
    let match: RegExpExecArray | null;

    while ((match = MARKDOWN_LINK_PATTERN.exec(text)) !== null) {
      const target = parseMarkdownLinkTarget(match[1]);
      if (shouldSkipTarget(target)) {
        continue;
      }
      if (resolveLocalMarkdownTarget(root, sourceFile, target) === null) {
        missingLinks.push({
          sourceFile,
          target,
          line: lineForIndex(lineStarts, match.index),
        });
      }
    }
  }

  return { checkedFileCount: files.length, missingLinks };
}

/**
 * Recursively list Markdown files below a root.
 * @param root - Root directory to scan
 * @returns Markdown files relative to root
 */
function listAllMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const ignoredDirectories = new Set(['.git', '.yarn', 'node_modules', 'dist', 'coverage']);

  /**
   * Visit a directory and collect Markdown descendants.
   * @param directory - Absolute directory path to inspect
   */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          visit(join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(relative(root, join(directory, entry.name)));
      }
    }
  }

  visit(root);
  return files;
}

/**
 * Run a git command and return stdout.
 * @param args - Git CLI arguments
 * @returns Command stdout
 */
function listGitFiles(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/**
 * Parse newline-separated git file output.
 * @param output - Git stdout
 * @returns File list
 */
function parseGitFileList(output: string): string[] {
  return output
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
}

/**
 * Normalize user-provided scan paths relative to the repository root.
 * @param root - Repository root
 * @param paths - Raw file or directory paths
 * @returns Normalized paths relative to root
 */
function normalizeScanPaths(root: string, paths: string[]): string[] {
  return paths
    .map((path) => relative(root, resolve(root, path)))
    .map((path) => (path === '' ? '.' : path))
    .sort();
}

/**
 * Check whether a file is inside the requested scan paths.
 * @param file - Markdown file path relative to root
 * @param scanPaths - Optional file or directory paths relative to root
 * @returns True when the file should be scanned
 */
function isWithinScanPaths(file: string, scanPaths: string[]): boolean {
  if (scanPaths.length === 0) {
    return true;
  }
  return scanPaths.some((scanPath) => scanPath === '.' || file === scanPath || file.startsWith(`${scanPath}/`));
}

/**
 * Decide whether a link target is not a local filesystem path.
 * @param target - Parsed link target
 * @returns True when the target should not be checked
 */
function shouldSkipTarget(target: string): boolean {
  return (
    target.length === 0 ||
    target.startsWith('#') ||
    target.startsWith('/') ||
    URL_SCHEME_PATTERN.test(target) ||
    target.startsWith('data:')
  );
}

/**
 * Build an index of line starts for line-number lookup.
 * @param text - File contents
 * @returns Character offsets for every line start
 */
function collectLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * Convert a character offset to a one-based line number.
 * @param lineStarts - Character offsets for line starts
 * @param index - Character offset to locate
 * @returns One-based line number
 */
function lineForIndex(lineStarts: number[], index: number): number {
  let line = 0;
  for (let cursor = 0; cursor < lineStarts.length; cursor += 1) {
    if (lineStarts[cursor] > index) {
      break;
    }
    line = cursor;
  }
  return line + 1;
}

/**
 * Print CLI usage information.
 */
function printHelp(): void {
  console.log(`Usage: tsx scripts/check-markdown-links.ts [--changed|--all] [--path <path>...]

Checks local Markdown links. --changed is the default and scans staged plus unstaged Markdown files.
Use --path to limit the selected files to one or more Markdown files or directories.
`);
}

/**
 * Run the Markdown link checker CLI.
 */
function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const options = parseCliArgs(args);
  const files = collectMarkdownFiles({
    mode: options.mode,
    root: options.root,
    scanPaths: options.scanPaths,
    listGitFiles,
    listAllFiles: listAllMarkdownFiles,
  });
  const existingFiles = files.filter(
    (file) => existsSync(resolve(options.root, file)) && statSync(resolve(options.root, file)).isFile(),
  );
  const result = checkMarkdownLinks(options.root, existingFiles);

  for (const missingLink of result.missingLinks) {
    console.log(`${missingLink.sourceFile}:${missingLink.line} missing ${missingLink.target}`);
  }

  console.log(`markdown-links: checked=${result.checkedFileCount} missing=${result.missingLinks.length}`);
  if (result.missingLinks.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

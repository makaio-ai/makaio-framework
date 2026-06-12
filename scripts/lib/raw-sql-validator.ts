/**
 * Raw-SQL call-site validator.
 *
 * Raw driver statements (`db.run/all/get/values`) and SQLite query-builder
 * terminals (`.run()` / `.all()` / `.get()` / `.values()`) bypass the
 * dialect-portable `RawSqlExecutor` seam exposed by `@makaio/storage-drizzle`
 * (`getRawSqlExecutor`). Builder terminals stay type-visible even after
 * `MakaioDatabase` drops the raw members — the builder typing is libsql's —
 * so this static scan is the only net that catches them before they break at
 * runtime on a non-SQLite backend.
 *
 * Scope: production sources (files under a `src/` segment), excluding test
 * files. Test suites intentionally keep raw calls until they migrate onto
 * `TestDbContext.exec` / `getRawSqlExecutor`.
 *
 * Known limitations (the type narrowing of `MakaioDatabase` is the primary
 * net for raw driver calls; this scan is the secondary regression net):
 * - Raw driver calls are matched on the `db` / `this.db` naming convention.
 * - Builder terminals are matched when the chain root (`db.select(` etc.)
 *   appears in the same statement; builders assigned to intermediate
 *   variables are not traced.
 *
 * Reviewed exceptions are suppressed with a `raw-sql-validator-allow` comment
 * on the offending line or the line directly above it.
 * @packageDocumentation
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** A single raw-SQL call site that bypasses the executor seam. */
export interface RawSqlViolation {
  /** File path relative to the scanned root. */
  readonly file: string;
  /** 1-based line of the match. */
  readonly line: number;
  /** Which pattern matched. */
  readonly kind: 'raw-driver-call' | 'builder-terminal';
  /** Trimmed source line for the report. */
  readonly snippet: string;
}

/** A violation before file attribution (content-level scan result). */
export type RawSqlContentViolation = Omit<RawSqlViolation, 'file'>;

/** Suppression token for reviewed exceptions (same line or the line above). */
export const RAW_SQL_SUPPRESSION_TOKEN = 'raw-sql-validator-allow';

/**
 * Production files allowed to touch the native raw driver surface directly.
 * Paths are relative to the scanned root, POSIX-separated.
 */
export const RAW_SQL_ALLOWLIST: readonly string[] = [
  // SQLite driver factory: applies connection PRAGMAs on the concrete driver
  // handle before it is cast to MakaioDatabase and branded with its executor.
  'storage/drizzle/src/engine/sqlite/client.ts',
  // The executor implementation itself delegates to the native driver API.
  'storage/drizzle/src/raw-sql.ts',
];

/**
 * Raw driver-level statement calls on the conventional handle names,
 * including generic instantiations (`db.all<{ name: string }>(…)`).
 */
const RAW_DRIVER_CALL = /\bdb\s*\.\s*(?:run|all|get|values)\s*[<(]/g;

/**
 * Zero-argument execution terminal in method-chain position. `\s` spans
 * newlines, so terminals on their own line after a multi-line builder chain
 * are matched.
 */
const BUILDER_TERMINAL = /\)\s*\.\s*(?:run|all|get|values)\s*\(\s*\)/g;

/**
 * Drizzle chain root that must precede a builder terminal within the same
 * statement for the terminal to count as a violation. This is what separates
 * `db.select(...).all()` from stdlib zero-argument calls such as
 * `new Map(...).values()`.
 */
const CHAIN_ROOT = /\b(?:db|tx)\s*\.\s*(?:select|selectDistinct|insert|update|delete)\s*\(/;

/** How far back (in characters) a builder terminal looks for its chain root. */
const CHAIN_ROOT_WINDOW = 1500;

/**
 * Replace comment and string/template-literal contents with spaces while
 * preserving offsets and newlines, so the call-site patterns never match
 * documentation, log messages, or SQL text.
 *
 * The scanner is a pragmatic state machine, not a parser: regex literals and
 * nested template interpolations may blank slightly too much, which can only
 * cause missed matches, never false positives.
 * @param content - TypeScript source text.
 * @returns Same-length text with comment and string contents blanked.
 */
export function blankCommentsAndStrings(content: string): string {
  const out = content.split('');
  type State = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';
  let state: State = 'code';

  /**
   * Blank the character at an index unless it is a newline.
   * @param index - Index into the output buffer.
   */
  const blank = (index: number): void => {
    if (out[index] !== '\n') {
      out[index] = ' ';
    }
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line-comment';
        blank(i);
        blank(i + 1);
        i++;
      } else if (ch === '/' && next === '*') {
        state = 'block-comment';
        blank(i);
        blank(i + 1);
        i++;
      } else if (ch === "'") {
        state = 'single';
      } else if (ch === '"') {
        state = 'double';
      } else if (ch === '`') {
        state = 'template';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (ch === '\n') {
        state = 'code';
      } else {
        blank(i);
      }
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        blank(i);
        blank(i + 1);
        i++;
      } else {
        blank(i);
      }
      continue;
    }

    // String states: blank contents, honor escapes, close on the matching quote.
    const closingQuote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (ch === '\\') {
      blank(i);
      if (next !== undefined) {
        blank(i + 1);
        i++;
      }
    } else if (ch === closingQuote) {
      state = 'code';
    } else {
      blank(i);
    }
  }

  return out.join('');
}

/**
 * Compute the 1-based line number of a character offset.
 * @param content - Full text.
 * @param index - Character offset into the text.
 * @returns 1-based line number.
 */
function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') {
      line++;
    }
  }
  return line;
}

/**
 * Returns `true` when the violation is suppressed via the
 * {@link RAW_SQL_SUPPRESSION_TOKEN} comment on the match line or a standalone
 * comment line directly above it. The line-above form requires a comment line
 * so an inline suppression never leaks onto the following statement.
 * @param originalLines - Original (un-blanked) source lines.
 * @param line - 1-based line of the match.
 * @returns Whether the match is a reviewed exception.
 */
function isSuppressed(originalLines: readonly string[], line: number): boolean {
  const current = originalLines[line - 1] ?? '';
  if (current.includes(RAW_SQL_SUPPRESSION_TOKEN)) {
    return true;
  }
  const previous = (originalLines[line - 2] ?? '').trim();
  if (!previous.includes(RAW_SQL_SUPPRESSION_TOKEN)) {
    return false;
  }
  return previous.startsWith('//') || previous.startsWith('/*') || previous.startsWith('*');
}

/**
 * Returns `true` when a builder terminal at `matchIndex` is rooted in a
 * drizzle chain within the same statement.
 * @param blanked - Comment/string-blanked source text.
 * @param matchIndex - Offset of the terminal match.
 * @returns Whether a drizzle chain root precedes the terminal.
 */
function hasChainRoot(blanked: string, matchIndex: number): boolean {
  let window = blanked.slice(Math.max(0, matchIndex - CHAIN_ROOT_WINDOW), matchIndex);
  const statementBoundary = window.lastIndexOf(';');
  if (statementBoundary !== -1) {
    window = window.slice(statementBoundary + 1);
  }
  return CHAIN_ROOT.test(window);
}

/**
 * Scan one file's content for raw-SQL call sites that bypass the executor.
 * @param content - TypeScript source text.
 * @returns Content-level violations (no file attribution), in source order.
 */
export function findRawSqlViolations(content: string): RawSqlContentViolation[] {
  const blanked = blankCommentsAndStrings(content);
  const originalLines = content.split('\n');
  const violations: RawSqlContentViolation[] = [];

  /**
   * Collect matches of one pattern.
   * @param pattern - Global pattern to run over the blanked content.
   * @param kind - Violation kind to record.
   * @param accept - Optional extra predicate on the match offset.
   */
  const collect = (pattern: RegExp, kind: RawSqlViolation['kind'], accept?: (matchIndex: number) => boolean): void => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(blanked); match !== null; match = pattern.exec(blanked)) {
      if (accept !== undefined && !accept(match.index)) {
        continue;
      }
      // Builder-terminal matches start at the `)` of the previous chain link,
      // which can sit on an earlier line; report (and suppress) at the member
      // access itself.
      const anchorOffset = kind === 'builder-terminal' ? match.index + match[0].indexOf('.') : match.index;
      const line = lineOf(blanked, anchorOffset);
      if (isSuppressed(originalLines, line)) {
        continue;
      }
      violations.push({ line, kind, snippet: (originalLines[line - 1] ?? '').trim() });
    }
  };

  collect(RAW_DRIVER_CALL, 'raw-driver-call');
  collect(BUILDER_TERMINAL, 'builder-terminal', (matchIndex) => hasChainRoot(blanked, matchIndex));

  return violations.sort((a, b) => a.line - b.line);
}

/**
 * Returns `true` when a relative path is a production source file in scope.
 * @param relativePath - POSIX-separated path relative to the scanned root.
 * @returns Whether the file should be scanned.
 */
export function isInScope(relativePath: string): boolean {
  if (!/(^|\/)src\//.test(relativePath)) return false;
  if (relativePath.includes('/__tests__/')) return false;
  if (/\.(test|spec)\.tsx?$/.test(relativePath)) return false;
  if (RAW_SQL_ALLOWLIST.includes(relativePath)) return false;
  return true;
}

/**
 * Recursively collect TypeScript files under a directory, skipping
 * dependency and build output trees.
 * @param dir - Absolute directory to walk.
 * @returns Absolute file paths.
 */
function collectTypeScriptFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dirent uses lstat semantics, so symlinked directories already fail
    // isDirectory(); the explicit skip also excludes symlinked files and
    // documents that the walk never leaves the physical tree.
    if (entry.isSymbolicLink()) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.generated') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTypeScriptFiles(fullPath));
    } else if (/\.tsx?$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Scan a workspace root for raw-SQL call sites that bypass the executor seam.
 * @param rootDir - Absolute path to the workspace root to scan.
 * @returns All violations with root-relative file attribution.
 */
export function scanForRawSqlViolations(rootDir: string): RawSqlViolation[] {
  const violations: RawSqlViolation[] = [];
  for (const filePath of collectTypeScriptFiles(rootDir)) {
    const relativePath = relative(rootDir, filePath).split('\\').join('/');
    if (!isInScope(relativePath)) continue;
    const content = readFileSync(filePath, 'utf8');
    for (const violation of findRawSqlViolations(content)) {
      violations.push({ file: relativePath, ...violation });
    }
  }
  return violations;
}

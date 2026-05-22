/**
 * Atomic file read-modify-write utility with per-path mutex serialization.
 *
 * Provides a generic helper for safely updating JSON config files: reads the
 * current JSON, validates it through a caller-supplied parser, applies a
 * modifier, and writes the result atomically (write-to-UUID-tmp then rename).
 * Concurrent calls to the same path are serialized via the caller-owned mutex
 * map.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Descriptor returned by an {@link AtomicModifier}.
 * @typeParam TContent - The JSON-serializable type of the file's content.
 * @typeParam TResult - An arbitrary caller-defined result value.
 */
export interface AtomicModifyOutcome<TContent, TResult> {
  /**
   * The (potentially updated) content to persist.  Ignored when
   * `changed` is `false`.
   */
  readonly content: TContent;
  /**
   * Whether the file should be written.  When `false`, no I/O is performed
   * and the resolved promise carries `result` without touching the disk.
   */
  readonly changed: boolean;
  /** Caller-defined value forwarded as the resolved value of {@link atomicModifyFile}. */
  readonly result: TResult;
}

/**
 * Modifier function supplied by the caller.
 *
 * Receives the current file content (or the default value when the file is
 * absent) and returns an {@link AtomicModifyOutcome} describing the desired
 * new content and whether a write is needed.
 *
 * The modifier **must be synchronous or return a resolved-in-the-same-tick
 * promise** — it runs inside the mutex chain so async work inside the modifier
 * is safe, but long-running modifiers will delay subsequent serialized writes.
 * @typeParam TContent - The JSON-serializable type of the file's content.
 * @typeParam TResult - An arbitrary caller-defined result value.
 */
export type AtomicModifier<TContent, TResult> = (
  current: TContent,
) => AtomicModifyOutcome<TContent, TResult> | Promise<AtomicModifyOutcome<TContent, TResult>>;

/**
 * Parser function supplied by the caller.
 *
 * The helper reads disk JSON as `unknown`; client-specific settings modules
 * own the schema that turns unknown JSON into a trusted content type.
 * @typeParam TContent - The validated content type consumed by the modifier.
 */
export type AtomicContentParser<TContent> = (raw: unknown) => TContent;

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Read the current file content, validate it with `parseContent`, apply
 * `modifier`, and atomically persist the result when `changed` is `true`.
 *
 * **Atomicity:** the updated content is written to a UUID-suffixed sibling file
 * in the same directory, then renamed into place.  Readers never observe a
 * partial write.  The temp file is unlinked on write failure.
 *
 * **Serialization:** the caller owns the `mutex` map and passes the same
 * instance for all calls sharing the same logical file namespace.  The helper
 * chains on the existing in-flight promise for `filePath` so concurrent calls
 * are queued rather than racing.  The entry is pruned from the map once no
 * further work is queued.
 *
 * **Parent directory:** created automatically when absent (`mkdir -p`).
 * @typeParam TContent - The JSON-serializable type of the file's content.
 * @typeParam TResult - An arbitrary caller-defined result value.
 * @param filePath - Absolute path to the target file.
 * @param defaultContent - Raw value parsed when the file does not exist.
 * @param mutex - Module-scoped per-path mutex map owned by the caller.
 * @param parseContent - Parser that validates unknown disk JSON before mutation.
 * @param modifier - Pure function that transforms the current content.
 * @returns The `result` value produced by `modifier`.
 */
export async function atomicModifyFile<TContent, TResult>(
  filePath: string,
  defaultContent: unknown,
  mutex: Map<string, Promise<void>>,
  parseContent: AtomicContentParser<TContent>,
  modifier: AtomicModifier<TContent, TResult>,
): Promise<TResult> {
  let resolvedResult!: TResult;

  const previous = mutex.get(filePath) ?? Promise.resolve();
  const next = previous.then(async () => {
    const current = parseContent(await readJsonFile(filePath, defaultContent));
    const outcome = await modifier(current);
    if (outcome.changed) {
      await writeJsonFileAtomic(filePath, outcome.content);
    }
    resolvedResult = outcome.result;
  });

  const idle = next.then(
    () => undefined,
    () => undefined,
  );
  mutex.set(filePath, idle);

  try {
    await next;
  } finally {
    if (mutex.get(filePath) === idle) {
      mutex.delete(filePath);
    }
  }

  return resolvedResult;
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/**
 * Read and JSON-parse a file, returning `defaultContent` when the file is
 * absent.  Re-throws all other errors (corrupt JSON, permission denied, etc.).
 * @param filePath - Absolute path to the file to read.
 * @param defaultContent - Returned when `ENOENT` is encountered.
 * @returns Parsed file content or `defaultContent`.
 */
async function readJsonFile(filePath: string, defaultContent: unknown): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultContent;
    }
    throw error;
  }
  return JSON.parse(raw) as unknown;
}

/**
 * Atomically write `content` as JSON to `filePath`.
 *
 * Creates the parent directory when absent, writes to a UUID-suffixed temp
 * file in the same directory, then renames to the target path.  Cleans up
 * the temp file on failure.
 * @param filePath - Absolute path to the target file.
 * @param content - JSON-serializable value to persist.
 */
async function writeJsonFileAtomic<T>(filePath: string, content: T): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `${path.basename(filePath)}.${randomUUID()}.tmp`);

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

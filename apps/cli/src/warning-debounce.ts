/**
 * Debounce repeated CLI warnings (e.g. "server not reachable") so they appear
 * at most once per {@link DEBOUNCE_WINDOW_MS} per working directory.
 *
 * State is persisted as tiny JSON files keyed by a hash of the CWD under
 * `$MAKAIO_HOME/cache/cli-warnings/`. All I/O is synchronous and best-effort —
 * a missing or corrupted cache file simply means the next warning is shown.
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** Warnings for the same CWD are suppressed for this duration. */
const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Derive the cache directory for CLI warning state files.
 * @param makaioHome - Resolved `$MAKAIO_HOME` (typically `~/.makaio`).
 * @returns Absolute path to the warning cache directory.
 */
function warningCacheDir(makaioHome: string): string {
  return path.join(makaioHome, 'cache', 'cli-warnings');
}

/**
 * Produce a short, filesystem-safe hash of a CWD path.
 * @param cwd - Absolute working directory.
 * @returns 16-character hex digest.
 */
function hashCwd(cwd: string): string {
  return crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

/**
 * Check whether a warning for the given CWD was shown recently enough that
 * it should be suppressed.
 * @param makaioHome - Resolved Makaio data home.
 * @param cwd - Current working directory to key on.
 * @returns `true` when the warning should be suppressed.
 */
export function shouldSuppressWarning(makaioHome: string, cwd: string = process.cwd()): boolean {
  const cacheFile = path.join(warningCacheDir(makaioHome), `${hashCwd(cwd)}.json`);
  try {
    const raw = fs.readFileSync(cacheFile, 'utf-8');
    const data: unknown = JSON.parse(raw);
    if (typeof data === 'object' && data !== null && 'lastWarnedAt' in data) {
      const { lastWarnedAt } = data as { lastWarnedAt: unknown };
      if (typeof lastWarnedAt === 'number' && Date.now() - lastWarnedAt < DEBOUNCE_WINDOW_MS) {
        return true;
      }
    }
  } catch {
    // File missing or corrupted — don't suppress.
  }
  return false;
}

/**
 * Record that a warning was just shown for the given CWD so subsequent
 * invocations within the debounce window can be suppressed.
 *
 * Also evicts stale cache files whose `lastWarnedAt` has expired beyond
 * the debounce window, preventing unbounded growth.
 * @param makaioHome - Resolved Makaio data home.
 * @param cwd - Current working directory to key on.
 */
export function recordWarningShown(makaioHome: string, cwd: string = process.cwd()): void {
  const cacheDir = warningCacheDir(makaioHome);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const ownFile = `${hashCwd(cwd)}.json`;
    fs.writeFileSync(path.join(cacheDir, ownFile), JSON.stringify({ lastWarnedAt: Date.now() }));
    evictStaleEntries(cacheDir, ownFile);
  } catch {
    // Best-effort — failure to persist is not critical.
  }
}

/**
 * Remove cache files whose `lastWarnedAt` has expired beyond the debounce
 * window. Runs synchronously and best-effort — individual file failures are
 * silently ignored.
 * @param cacheDir - Absolute path to the warning cache directory.
 * @param skip - Filename to skip (the file just written by the caller).
 */
function evictStaleEntries(cacheDir: string, skip: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry === skip) continue;
    const filePath = path.join(cacheDir, entry);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data: unknown = JSON.parse(raw);
      if (
        typeof data === 'object' &&
        data !== null &&
        'lastWarnedAt' in data &&
        typeof (data as { lastWarnedAt: unknown }).lastWarnedAt === 'number' &&
        now - (data as { lastWarnedAt: number }).lastWarnedAt >= DEBOUNCE_WINDOW_MS
      ) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Corrupted file — remove it too.
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Give up on this entry.
      }
    }
  }
}

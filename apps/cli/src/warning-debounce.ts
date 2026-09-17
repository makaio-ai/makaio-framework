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
 * Return `true` when `lastWarnedAt` falls within the debounce window relative
 * to now.
 *
 * A negative elapsed value (clock stepped backwards) is treated as outside the
 * window so a future timestamp never keeps the suppression alive indefinitely.
 * @param lastWarnedAt - Millisecond epoch timestamp of the last recorded event.
 * @returns `true` when the elapsed time is non-negative and less than
 *   {@link DEBOUNCE_WINDOW_MS}.
 */
function isWithinDebounceWindow(lastWarnedAt: number): boolean {
  const elapsed = Date.now() - lastWarnedAt;
  return elapsed >= 0 && elapsed < DEBOUNCE_WINDOW_MS;
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
      if (typeof lastWarnedAt === 'number' && isWithinDebounceWindow(lastWarnedAt)) {
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

// ---------------------------------------------------------------------------
// Hook failure cool-down (keyed by composite CWD + busUrl scope)
// ---------------------------------------------------------------------------

/**
 * Check whether the hook-failure cool-down for the given composite key is
 * active.  Uses the same {@link DEBOUNCE_WINDOW_MS} window as
 * {@link shouldSuppressWarning}, but stores state in a `*.hook.json` file
 * so the two families never collide.
 * @param makaioHome - Resolved Makaio data home.
 * @param hookKey - Composite deduplication key, typically `cwd + '\n' + busUrl`.
 *   Never logged.
 * @returns `true` when the cool-down is active and the hook shortcut should
 *   fire.
 */
export function shouldSuppressHookCoolDown(makaioHome: string, hookKey: string): boolean {
  const cacheFile = path.join(warningCacheDir(makaioHome), `${hashCwd(hookKey)}.hook.json`);
  try {
    const raw = fs.readFileSync(cacheFile, 'utf-8');
    const data: unknown = JSON.parse(raw);
    if (typeof data === 'object' && data !== null && 'lastWarnedAt' in data) {
      const { lastWarnedAt } = data as { lastWarnedAt: unknown };
      if (typeof lastWarnedAt === 'number' && isWithinDebounceWindow(lastWarnedAt)) {
        return true;
      }
    }
  } catch {
    // File missing or corrupted — cool-down not active.
  }
  return false;
}

/**
 * Record a hook-failure event for the given composite key so subsequent
 * invocations within {@link DEBOUNCE_WINDOW_MS} can be short-circuited.
 *
 * Also evicts stale `*.json` and `*.hook.json` files from the same cache
 * directory (via the shared {@link evictStaleEntries} helper).
 * @param makaioHome - Resolved Makaio data home.
 * @param hookKey - Composite deduplication key, typically `cwd + '\n' + busUrl`.
 *   Never logged.
 */
export function recordHookCoolDown(makaioHome: string, hookKey: string): void {
  const cacheDir = warningCacheDir(makaioHome);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const ownFile = `${hashCwd(hookKey)}.hook.json`;
    fs.writeFileSync(path.join(cacheDir, ownFile), JSON.stringify({ lastWarnedAt: Date.now() }));
    evictStaleEntries(cacheDir, ownFile);
  } catch {
    // Best-effort — failure to persist is not critical.
  }
}

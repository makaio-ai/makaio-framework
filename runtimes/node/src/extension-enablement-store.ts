/**
 * Extension enablement store.
 *
 * Reads and writes `<makaioHome>/config/extensions.json` — a single JSON file
 * whose `"disabled"` array lists extension names that have been turned off by
 * the user or operator. An absent name means the extension is enabled (the
 * default). Only disabled names are stored, keeping the file self-cleaning and
 * easy to hand-edit: an empty `{}` object or a missing file both mean "all
 * extensions enabled".
 *
 * The store is the single source of truth for headless enable/disable: the CLI
 * writes it offline, and the boot path wires it as the coordinator's
 * `persistEnabled` callback so operator commands and the running server write
 * the same file. Any
 * number of processes may hold a store instance and call `persistEnabled`
 * concurrently — `persistEnabled` serializes its read-modify-write cycle
 * behind a cross-process file lock (see `ENABLEMENT_LOCK_OPTIONS`), so a
 * write from one process can never silently discard a write from another.
 *
 * Reading and writing disagree on purpose about what to do with a file that
 * exists but cannot be parsed. `loadExtensionEnablementStore`'s initial read
 * degrades to all-enabled with a recorded failure, because a corrupt file
 * must never block the runtime from booting. `persistEnabled`'s
 * read-modify-write instead refuses the write outright: merging one new name
 * into that same failure's empty `disabled` set and writing it back would
 * silently erase every name the file already recorded, undoing every prior
 * disable. See `readEnablementFile`'s write-path caller for the check.
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { lock as acquireEnablementFileLock } from 'proper-lockfile';
import type { ExtensionConfigProvider } from '@makaio/contracts';
import { summarizeDiagnosticText } from '@makaio/utils';

/** File path segments relative to the Makaio home. */
const ENABLEMENT_FILE_SEGMENTS = ['config', 'extensions.json'] as const;

/**
 * Cross-process lock policy guarding the enablement file's read-modify-write.
 *
 * `proper-lockfile` is already a Makaio dependency for exactly this kind of
 * multi-process file coordination (see the native credential-source locks in
 * `@makaio/client-claude-code` and `@makaio/client-codex`), so this reuses it
 * rather than hand-rolling a second lock primitive. `realpath: false` is
 * required because the target enablement file frequently does not exist yet
 * (first write creates it); resolving its real path first would throw ENOENT
 * before the lock could even be attempted. Leaving `lockfilePath` at its
 * default names the lock `extensions.json.lock`, sitting next to the file it
 * guards.
 *
 * The guarded critical section is a single read, an in-memory set merge, and
 * one atomic rename — realistically sub-millisecond. `stale` is deliberately
 * generous relative to that: it only fires when a process holding the lock
 * died before releasing it, not under ordinary contention. `retries` bounds
 * how long a waiting process spins against a lock a live holder is refreshing
 * before it gives up with a clear `ELOCKED` error, rather than retrying forever.
 */
const ENABLEMENT_LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 50, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
} as const;

/**
 * Largest enablement file the loader will read into memory.
 *
 * The file holds extension names — strings that are at most a few dozen bytes
 * each. A megabyte gives room for thousands of names before the guard fires,
 * which is far beyond any realistic extension registry. The bound exists
 * because the loader runs on the boot path and reads whatever is in the
 * location; a stray large file must not block startup.
 */
export const MAX_ENABLEMENT_FILE_BYTES = 1024 * 1024;

/**
 * Wire shape of the enablement JSON file.
 *
 * The file stores only disabled names. Absent name → enabled (default).
 * `true` entries are never written: the file is self-cleaning.
 */
export interface ExtensionEnablementFileData {
  /** Names of extensions that have been explicitly disabled. */
  readonly disabled: readonly string[];
}

/**
 * Typed result surface for a failed enablement file read.
 *
 * Recorded as metadata so the caller can log or surface it without coupling
 * to the error shape the reader uses internally.
 */
export type ExtensionEnablementReadFailureReason =
  | 'too-large'
  | 'not-json'
  | 'not-object'
  | 'invalid-disabled-field'
  | 'unreadable';

/** Failure detail returned when the file exists but cannot be used. */
export interface ExtensionEnablementReadFailure {
  readonly reason: ExtensionEnablementReadFailureReason;
  readonly diagnostic: string;
}

/**
 * Read-write store for persisted extension enablement.
 *
 * Extends the read-only subset of {@link ExtensionConfigProvider} so the
 * runtime can pass the same object where only `loadEnabled` is needed, and
 * so the coordinator can call `persistEnabled` directly.
 */
export interface ExtensionEnablementStore
  extends Required<Pick<ExtensionConfigProvider, 'loadEnabled' | 'persistEnabled'>> {
  /**
   * Load failure recorded during initialization, if any.
   *
   * `undefined` when the file was absent (treated as all-enabled) or parsed
   * successfully. Present when the file existed but could not be used, so the
   * caller can log the diagnostic before forwarding the store.
   */
  readonly readFailure: ExtensionEnablementReadFailure | undefined;
}

/**
 * Minimal package view required by {@link isExtensionEnabled} to apply the
 * critical-override rule.
 */
export interface ExtensionCriticalView {
  /** When `true`, the extension must start even when the store marks it disabled. */
  readonly critical?: boolean;
}

/**
 * Check whether a named extension is effectively enabled.
 *
 * Centralises the `loadEnabled(name) !== false` pattern used at every
 * enablement-gate site so callers do not repeat the three-valued logic
 * (`true` = enabled, `false` = disabled, `undefined` = enabled by default).
 *
 * The critical override is part of the answer, not an optional refinement: a
 * `critical: true` extension is treated as enabled regardless of what the
 * store says, mirroring the coordinator's `load()` logic exactly. `pkg` is
 * therefore required — a caller that cannot supply it is asking a different
 * question and would silently drop the override. This ensures that every gate
 * (clients, runtimeBoot, scheduler policy, the CLI listing) honours the same
 * invariant as the coordinator: a critical extension that the operator
 * hand-disabled still contributes to the running runtime.
 * @param store - Enablement store (or any object with an optional `loadEnabled`).
 * @param name - Extension package name to check.
 * @param pkg - Package view carrying the `critical` flag; `critical: true` overrides a disabled store entry.
 * @returns `true` when the extension is enabled, has no persisted preference, or is critical.
 */
export function isExtensionEnabled(
  store: { readonly loadEnabled?: (name: string) => boolean | undefined },
  name: string,
  pkg: ExtensionCriticalView,
): boolean {
  return store.loadEnabled?.(name) !== false || (pkg.critical ?? false);
}

/**
 * Check whether the store records an explicit disable for a name.
 *
 * This is the raw persisted preference, deliberately without the critical
 * override that {@link isExtensionEnabled} applies: it answers "did someone
 * turn this off in the enablement file?", not "will it run?". Use it only
 * where the persisted preference itself is the subject — for example when
 * reporting back whether a requested preference survived a rejected live
 * toggle. Every runtime gate must use {@link isExtensionEnabled} instead.
 * @param store - Enablement store (or any object with an optional `loadEnabled`).
 * @param name - Extension package name to check.
 * @returns `true` when the store explicitly disables the name.
 */
export function isExtensionDisabledInStore(
  store: { readonly loadEnabled?: (name: string) => boolean | undefined },
  name: string,
): boolean {
  return store.loadEnabled?.(name) === false;
}

/**
 * Resolve the absolute path of the enablement file for a given Makaio home.
 * @param makaioHome - Absolute Makaio data-home path.
 * @returns Absolute path to the enablement file. The file may not exist yet.
 */
export function resolveExtensionEnablementFile(makaioHome: string): string {
  return path.join(makaioHome, ...ENABLEMENT_FILE_SEGMENTS);
}

/**
 * Load an {@link ExtensionEnablementStore} backed by the file at
 * `<makaioHome>/config/extensions.json`.
 *
 * A missing file is silently treated as all-extensions-enabled. A file that
 * exists but cannot be used (too large, invalid JSON, wrong shape) records a
 * failure on the returned store and defaults to all-extensions-enabled, so a
 * corrupt file never bricks the runtime. The failure is exposed so the
 * composition root can emit a warning.
 *
 * The store's `persistEnabled` is always safe to call regardless of whether
 * the file existed at load time. It creates the config directory on first
 * write.
 * @param makaioHome - Absolute Makaio data-home path.
 * @returns Resolved enablement store, ready for use as a coordinator callback.
 */
export async function loadExtensionEnablementStore(makaioHome: string): Promise<ExtensionEnablementStore> {
  const filePath = resolveExtensionEnablementFile(makaioHome);
  const { disabled, readFailure } = await readEnablementFile(filePath);
  const disabledSet = new Set(disabled);

  // Serializes this instance's own persistEnabled calls so two of them never
  // interleave their read and write halves — see the comment inside
  // persistEnabled for why that interleaving is otherwise possible even
  // within one process (e.g. a boot-time default write racing an operator
  // toggle, or a UI batch that fires several `setEnabled` RPCs concurrently
  // against one running server, each landing on this same store instance).
  let writeQueue: Promise<unknown> = Promise.resolve();

  return {
    readFailure,

    loadEnabled(name: string): boolean | undefined {
      return disabledSet.has(name) ? false : undefined;
    },

    persistEnabled(name: string, enabled: boolean): Promise<void> {
      const run = async (): Promise<void> => {
        // Re-reading the file does not, by itself, make this read-modify-write
        // cycle atomic: the rename in `writeEnablementFile` only makes each
        // write atomic, not the read-then-write pair, so two concurrent callers
        // could still read the same snapshot and the later rename would
        // silently discard the earlier one's change. `writeQueue` above closes
        // that gap for calls on *this* instance by serializing them, and the
        // cross-process lock acquired below closes it for calls originating in
        // *other* processes — the CLI writes the file directly for names a
        // reachable server does not manage (see `applyUnmanagedNameToggle` in
        // `extension-toggle-commands.ts`) even while that server's own
        // `persistEnabled` may be writing concurrently for a different name, so
        // more than one process legitimately holds a writable store instance
        // for this file at the same time. The lock, not process exclusivity, is
        // what makes their read-modify-write cycles safe against each other.
        //
        // The config directory must exist before the lock is acquired: the
        // lock is itself a file (`proper-lockfile` creates it with `mkdir`),
        // and creating it inside a directory that does not exist yet would
        // fail with ENOENT rather than the expected EEXIST/stale-lock path.
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        const release = await acquireEnablementFileLock(filePath, ENABLEMENT_LOCK_OPTIONS);
        try {
          const { disabled: currentDisabled, readFailure: currentReadFailure } = await readEnablementFile(filePath);

          // `readEnablementFile` already maps a genuinely absent file (ENOENT)
          // to `readFailure: undefined` — see the comment in that function —
          // so any failure that reaches this point is a file that exists but
          // could not be parsed (malformed JSON, oversized, wrong shape, or an
          // invalid `disabled` field). The boot-time read path tolerates that
          // by degrading to all-enabled so a corrupt file never blocks
          // startup, but a write must not: merging this call's one name into
          // the failure's empty `disabled` set and writing it back would
          // silently discard every name the file already recorded, undoing
          // every prior disable the operator made. Refuse the write instead
          // and surface the failure so the operator repairs or deletes the
          // file before retrying.
          if (currentReadFailure) {
            throw new Error(
              `Refusing to persist extension enablement for "${name}": the existing file at "${filePath}" ` +
                `could not be read (${currentReadFailure.reason}): ${currentReadFailure.diagnostic} ` +
                'Repair or delete the file, then retry.',
            );
          }

          const live = new Set(currentDisabled);
          if (enabled) {
            live.delete(name);
          } else {
            live.add(name);
          }
          await writeEnablementFile(filePath, [...live]);
        } finally {
          // Always release, even when the write above failed, so a write error
          // never leaves the lock (and its lockfile) held for other processes
          // to time out against.
          await release();
        }

        // Only commit to the local in-memory set once the write has actually
        // landed on disk. Updating it before the write settles would make a
        // failed write's rejected promise coexist with a `loadEnabled` that
        // already reports the new value — a later retry would then read that
        // uncommitted value back, conclude the preference is unchanged, skip
        // persistence, and let a runtime transition succeed while the file
        // still holds the old preference. Because this line only runs when the
        // `try` block above completed without throwing, a write failure (or a
        // release failure surfaced from the `finally`) never reaches here.
        if (enabled) {
          disabledSet.delete(name);
        } else {
          disabledSet.add(name);
        }
      };

      // Chain onto the queue regardless of whether the previous entry
      // succeeded or failed, so one failed write cannot permanently stall
      // every later call — but keep this call's own rejection visible to its
      // caller by returning `scheduled` itself, not the swallowed tail.
      const scheduled = writeQueue.then(run, run);
      writeQueue = scheduled.catch(() => undefined);
      return scheduled;
    },
  };
}

/**
 * Parsed result from {@link readEnablementFile}.
 */
interface ReadEnablementResult {
  /** Resolved disabled set; empty when the file is absent or unusable. */
  readonly disabled: readonly string[];
  /** Failure detail when the file existed but could not be parsed. */
  readonly readFailure: ExtensionEnablementReadFailure | undefined;
}

/**
 * Read and parse the enablement file, with tolerant error handling.
 *
 * Missing file → silent all-enabled (no failure).
 * File exists but is unusable → failure recorded, all-enabled default.
 * @param filePath - Absolute path to the enablement file.
 * @returns Parsed disabled set and optional failure detail.
 */
async function readEnablementFile(filePath: string): Promise<ReadEnablementResult> {
  let raw: string;
  try {
    const stat = await fs.stat(filePath);

    if (!stat.isFile()) {
      return {
        disabled: [],
        readFailure: {
          reason: 'unreadable',
          diagnostic: `Enablement path at "${filePath}" is not a regular file; treating all extensions as enabled.`,
        },
      };
    }

    if (stat.size > MAX_ENABLEMENT_FILE_BYTES) {
      return {
        disabled: [],
        readFailure: {
          reason: 'too-large',
          diagnostic: `Enablement file at "${filePath}" exceeds ${MAX_ENABLEMENT_FILE_BYTES} bytes (${stat.size} bytes); treating all extensions as enabled.`,
        },
      };
    }

    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    // ENOENT from either the stat or the read means the file is genuinely
    // absent — that, and only that, takes the silent all-enabled path. Every
    // other stat/read failure (EACCES, a symlink loop, an unreadable device
    // node, ...) must not be mistaken for "no file": treating it as absent
    // would silently re-enable every extension the operator explicitly
    // disabled, which is the opposite of what this file is for. Those
    // failures fall into the same 'unreadable' diagnostic the size/type
    // checks above use, so the composition root can warn about them.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { disabled: [], readFailure: undefined };
    }
    return {
      disabled: [],
      readFailure: {
        reason: 'unreadable',
        diagnostic: `Could not read enablement file at "${filePath}": ${summarizeDiagnosticText(String(err))}`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      disabled: [],
      readFailure: {
        reason: 'not-json',
        diagnostic: `Enablement file at "${filePath}" contains invalid JSON; treating all extensions as enabled.`,
      },
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      disabled: [],
      readFailure: {
        reason: 'not-object',
        diagnostic: `Enablement file at "${filePath}" is not a JSON object; treating all extensions as enabled.`,
      },
    };
  }

  const record = parsed as Record<string, unknown>;

  // An absent "disabled" key is valid and means "no extensions disabled".
  if (!('disabled' in record)) {
    return { disabled: [], readFailure: undefined };
  }

  const rawDisabled = record['disabled'];
  if (!Array.isArray(rawDisabled) || rawDisabled.some((item) => typeof item !== 'string')) {
    return {
      disabled: [],
      readFailure: {
        reason: 'invalid-disabled-field',
        diagnostic: `Enablement file at "${filePath}" has a "disabled" field that is not a string array; treating all extensions as enabled.`,
      },
    };
  }

  return { disabled: rawDisabled as string[], readFailure: undefined };
}

/**
 * Atomically write the enablement file.
 *
 * Writes to a temp file adjacent to the target, then renames over it so a
 * crash or concurrent writer never leaves a partial file. Creates the parent
 * config directory if it does not exist.
 * @param filePath - Absolute path to the enablement file.
 * @param disabled - Current set of disabled extension names to persist.
 */
async function writeEnablementFile(filePath: string, disabled: readonly string[]): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // An empty set writes `{}`, not `{"disabled":[]}` — the module doc treats
  // both as "all extensions enabled", but only `{}` matches the self-cleaning
  // invariant: the file only ever names extensions that are actually disabled.
  const data: Partial<ExtensionEnablementFileData> = disabled.length > 0 ? { disabled } : {};
  const content = `${JSON.stringify(data, null, 2)}\n`;

  // Write to a temp file in the same directory so the rename is atomic on
  // POSIX systems (same filesystem). The OS cleans up the temp file if the
  // process exits before the rename, and a subsequent boot reads the prior
  // committed state.
  const tmpFile = path.join(dir, `.extensions-${process.pid}-${Date.now()}.json.tmp`);
  try {
    await fs.writeFile(tmpFile, content, 'utf-8');
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    await fs.unlink(tmpFile).catch(() => undefined);
    throw err;
  }
}

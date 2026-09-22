import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  MAX_ENABLEMENT_FILE_BYTES,
  loadExtensionEnablementStore,
  resolveExtensionEnablementFile,
} from '../extension-enablement-store.js';

// `node:fs/promises`'s namespace export is non-configurable under Vitest's ESM
// runner, so `vi.spyOn(fs, 'stat')` cannot work here. Mocking the module and
// routing `stat` through a controllable mock — defaulting to the real
// implementation — lets one test inject a non-ENOENT stat failure without
// touching every other test's real filesystem interaction.
const statMock = vi.hoisted(() => vi.fn());
const renameMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  statMock.mockImplementation((...args: Parameters<typeof actual.stat>) => actual.stat(...args));
  renameMock.mockImplementation((...args: Parameters<typeof actual.rename>) => actual.rename(...args));
  return { ...actual, stat: statMock, rename: renameMock };
});

describe('extension enablement store', () => {
  let makaioHome: string;
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(async () => {
    makaioHome = await fs.mkdtemp(path.join(tmpdir(), 'makaio-enablement-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await fs.rm(makaioHome, { recursive: true, force: true });
  });

  /**
   * Write the enablement file, creating the config directory on demand.
   * @param content - Raw file content (may be invalid JSON for error tests).
   */
  async function writeFile(content: string): Promise<void> {
    const filePath = resolveExtensionEnablementFile(makaioHome);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Read the persisted file content.
   * @returns Parsed JSON content of the enablement file.
   */
  async function readFile(): Promise<unknown> {
    const filePath = resolveExtensionEnablementFile(makaioHome);
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as unknown;
  }

  it('resolves the enablement file path beneath the Makaio home', () => {
    const filePath = resolveExtensionEnablementFile(makaioHome);
    expect(filePath).toBe(path.join(makaioHome, 'config', 'extensions.json'));
  });

  describe('reading', () => {
    it('treats a missing file as all-extensions-enabled with no failure', async () => {
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure).toBeUndefined();
      expect(store.loadEnabled('anything')).toBeUndefined();
    });

    it('parses a valid disabled list and returns false for disabled extensions', async () => {
      await writeFile(JSON.stringify({ disabled: ['github', 'linear'] }));
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure).toBeUndefined();
      expect(store.loadEnabled('github')).toBe(false);
      expect(store.loadEnabled('linear')).toBe(false);
      expect(store.loadEnabled('other')).toBeUndefined();
    });

    it('treats an empty disabled array as all-extensions-enabled', async () => {
      await writeFile(JSON.stringify({ disabled: [] }));
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure).toBeUndefined();
      expect(store.loadEnabled('github')).toBeUndefined();
    });

    it('treats an object without a disabled key as all-extensions-enabled', async () => {
      await writeFile(JSON.stringify({}));
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure).toBeUndefined();
      expect(store.loadEnabled('anything')).toBeUndefined();
    });

    it('records a not-json failure and defaults to all-enabled when file contains invalid JSON', async () => {
      await writeFile('{ this is not json }');
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('not-json');
      expect(store.loadEnabled('anything')).toBeUndefined();
    });

    it('records a not-object failure when the file contains a JSON array', async () => {
      await writeFile(JSON.stringify(['github']));
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('not-object');
      expect(store.loadEnabled('github')).toBeUndefined();
    });

    it('records a not-object failure when the file contains a JSON primitive', async () => {
      await writeFile('"just a string"');
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('not-object');
    });

    it('records an invalid-disabled-field failure when disabled is not a string array', async () => {
      await writeFile(JSON.stringify({ disabled: [1, 2, 3] }));
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('invalid-disabled-field');
      expect(store.loadEnabled('anything')).toBeUndefined();
    });

    it('records an invalid-disabled-field failure when disabled is not an array', async () => {
      await writeFile(JSON.stringify({ disabled: 'github' }));
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('invalid-disabled-field');
    });

    it('records a too-large failure and defaults to all-enabled when file exceeds the size limit', async () => {
      const oversized = JSON.stringify({ disabled: ['x'.repeat(MAX_ENABLEMENT_FILE_BYTES)] });
      await writeFile(oversized);
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('too-large');
      expect(store.loadEnabled('anything')).toBeUndefined();
    });
  });

  describe('writing (persistEnabled)', () => {
    it('creates the config directory and file on first write', async () => {
      const store = await loadExtensionEnablementStore(makaioHome);
      await store.persistEnabled('github', false);
      const data = await readFile();
      expect(data).toEqual({ disabled: ['github'] });
    });

    it('adds a name to the disabled list when disabled', async () => {
      const store = await loadExtensionEnablementStore(makaioHome);
      await store.persistEnabled('github', false);
      await store.persistEnabled('linear', false);
      const data = await readFile();
      expect((data as { disabled: string[] }).disabled).toContain('github');
      expect((data as { disabled: string[] }).disabled).toContain('linear');
    });

    it('removes a name from the disabled list when enabled', async () => {
      await writeFile(JSON.stringify({ disabled: ['github', 'linear'] }));
      const store = await loadExtensionEnablementStore(makaioHome);
      await store.persistEnabled('github', true);
      const data = await readFile();
      expect((data as { disabled: string[] }).disabled).not.toContain('github');
      expect((data as { disabled: string[] }).disabled).toContain('linear');
    });

    it('is idempotent: enabling an already-enabled extension leaves the file unchanged', async () => {
      await writeFile(JSON.stringify({ disabled: ['linear'] }));
      const store = await loadExtensionEnablementStore(makaioHome);
      await store.persistEnabled('github', true);
      const data = await readFile();
      expect((data as { disabled: string[] }).disabled).toEqual(['linear']);
    });

    it('round-trips disable then enable correctly', async () => {
      const store = await loadExtensionEnablementStore(makaioHome);
      await store.persistEnabled('github', false);
      expect(store.loadEnabled('github')).toBe(false);
      await store.persistEnabled('github', true);
      expect(store.loadEnabled('github')).toBeUndefined();
      const data = await readFile();
      expect(data).toEqual({});
    });

    it('writes {} instead of {"disabled":[]} when the last disabled extension is re-enabled', async () => {
      await writeFile(JSON.stringify({ disabled: ['github'] }));
      const store = await loadExtensionEnablementStore(makaioHome);
      await store.persistEnabled('github', true);
      const data = await readFile();
      // Matches the module doc's "self-cleaning" invariant: the file only
      // ever names extensions that are actually disabled, never an empty
      // `disabled` array — {} and {"disabled":[]} both parse back to
      // all-extensions-enabled (see the "reading" describe block above), but
      // only {} matches what a hand-edited or freshly-cleaned file looks like.
      expect(data).toEqual({});
    });

    it('serializes concurrent persistEnabled calls on the same store instance so neither write is lost', async () => {
      const store = await loadExtensionEnablementStore(makaioHome);

      // Genuinely concurrent — not sequentially awaited — to exercise the
      // in-process write queue that serializes this instance's own calls so
      // their read and write halves cannot interleave.
      await Promise.all([store.persistEnabled('github', false), store.persistEnabled('linear', false)]);

      const data = await readFile();
      expect((data as { disabled: string[] }).disabled).toContain('github');
      expect((data as { disabled: string[] }).disabled).toContain('linear');
      expect(store.loadEnabled('github')).toBe(false);
      expect(store.loadEnabled('linear')).toBe(false);
    });

    it('two independently loaded stores each disabling a different name both survive genuinely concurrent writes (cross-process lock)', async () => {
      // Two store instances loaded from the same empty file at the same time —
      // simulates a CLI process and a running server, each with its own
      // in-process write queue and no shared JS state between them.
      const [storeA, storeB] = await Promise.all([
        loadExtensionEnablementStore(makaioHome),
        loadExtensionEnablementStore(makaioHome),
      ]);

      // Genuinely concurrent — not sequentially awaited. Without the
      // cross-process lock in `persistEnabled`, both instances could read the
      // same on-disk snapshot before either writes, and the later rename would
      // silently discard the earlier instance's change.
      await Promise.all([storeA.persistEnabled('linear', false), storeB.persistEnabled('github', false)]);

      // Both names must survive in the persisted file.
      const data = await readFile();
      expect((data as { disabled: string[] }).disabled).toContain('linear');
      expect((data as { disabled: string[] }).disabled).toContain('github');
    });

    it('steals a stale lock left behind by a dead process and completes the write', async () => {
      const filePath = resolveExtensionEnablementFile(makaioHome);
      const lockPath = `${filePath}.lock`;

      // Simulate a process that acquired the lock and then died before
      // releasing it: the lockfile exists, but its mtime is far older than the
      // stale threshold.
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.mkdir(lockPath);
      const longAgo = new Date(Date.now() - 20_000);
      await fs.utimes(lockPath, longAgo, longAgo);

      const store = await loadExtensionEnablementStore(makaioHome);
      await store.persistEnabled('github', false);

      const data = await readFile();
      expect((data as { disabled: string[] }).disabled).toContain('github');
      // The stolen lock is released again once this write completes.
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('retries against a fresh lock held by another process and succeeds once that process releases it', async () => {
      const filePath = resolveExtensionEnablementFile(makaioHome);
      const lockPath = `${filePath}.lock`;

      // A fresh lock (mtime "now") simulates another live process mid-write —
      // acquisition must wait, not steal it.
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.mkdir(lockPath);

      const releaseForeignLock = setTimeout(() => {
        fs.rmdir(lockPath).catch(() => undefined);
      }, 150);

      const store = await loadExtensionEnablementStore(makaioHome);
      try {
        await store.persistEnabled('github', false);
      } finally {
        clearTimeout(releaseForeignLock);
      }

      const data = await readFile();
      expect((data as { disabled: string[] }).disabled).toContain('github');
    });

    it('releases the cross-process lock without leaving a lockfile behind when the write fails', async () => {
      const store = await loadExtensionEnablementStore(makaioHome);
      const filePath = resolveExtensionEnablementFile(makaioHome);
      const lockPath = `${filePath}.lock`;

      const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      renameMock.mockRejectedValueOnce(denied);

      await expect(store.persistEnabled('github', false)).rejects.toThrow('EACCES');

      // The lock must be released even though the guarded write failed, so it
      // never blocks a subsequent process from acquiring it.
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not commit the in-memory value when the underlying write fails, so a subsequent read still reports the on-disk value', async () => {
      const store = await loadExtensionEnablementStore(makaioHome);

      const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      renameMock.mockRejectedValueOnce(denied);

      await expect(store.persistEnabled('github', false)).rejects.toThrow('EACCES');

      // The write never landed — loadEnabled on this same instance must not
      // report the uncommitted value, otherwise a retry would see "already
      // disabled", skip persistence, and let a runtime transition succeed
      // while the file still holds the old (enabled) preference.
      expect(store.loadEnabled('github')).toBeUndefined();
      const data = await readFile().catch(() => undefined);
      expect(data).toBeUndefined();

      // A retry after the transient failure clears must actually persist.
      await store.persistEnabled('github', false);
      expect(store.loadEnabled('github')).toBe(false);
      const retriedData = await readFile();
      expect((retriedData as { disabled: string[] }).disabled).toContain('github');
    });
  });

  describe('writing (persistEnabled) — refuses to write over an unparsable file', () => {
    it('rejects with a diagnostic error, leaves the file unchanged, and leaves no lockfile when the on-disk file is malformed JSON', async () => {
      const original = '{ this is not json }';
      await writeFile(original);
      const filePath = resolveExtensionEnablementFile(makaioHome);
      const lockPath = `${filePath}.lock`;

      const store = await loadExtensionEnablementStore(makaioHome);
      // Load-time read already recorded the failure; this asserts the
      // write-path guard, not the (already-covered) load-time behavior.
      expect(store.readFailure?.reason).toBe('not-json');

      await expect(store.persistEnabled('linear', false)).rejects.toThrow(/could not be read \(not-json\)/);

      // The file on disk must be byte-for-byte unchanged — no replacement
      // write happened.
      const rawAfter = await fs.readFile(filePath, 'utf-8');
      expect(rawAfter).toBe(original);

      // The lock must not be left behind for a later process to time out
      // against.
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

      // The in-memory cache must not have been mutated by the rejected call.
      expect(store.loadEnabled('linear')).toBeUndefined();
    });

    it('rejects with a diagnostic error and leaves the file unchanged when the on-disk "disabled" field is invalid', async () => {
      const original = JSON.stringify({ disabled: 'github' });
      await writeFile(original);
      const filePath = resolveExtensionEnablementFile(makaioHome);
      const lockPath = `${filePath}.lock`;

      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('invalid-disabled-field');

      await expect(store.persistEnabled('linear', false)).rejects.toThrow(
        /could not be read \(invalid-disabled-field\)/,
      );

      const rawAfter = await fs.readFile(filePath, 'utf-8');
      expect(rawAfter).toBe(original);
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(store.loadEnabled('linear')).toBeUndefined();
    });

    it('still writes successfully when the file is genuinely missing (ENOENT is not a refusal case)', async () => {
      // No file was ever written — the load-time read has no failure, and
      // this asserts the write-path guard treats absence as the legitimate
      // first-write case rather than a refusal.
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure).toBeUndefined();

      await store.persistEnabled('github', false);

      const data = await readFile();
      expect(data).toEqual({ disabled: ['github'] });
    });

    it('succeeds on retry once the malformed file has been repaired', async () => {
      await writeFile('{ this is not json }');
      const store = await loadExtensionEnablementStore(makaioHome);

      await expect(store.persistEnabled('linear', false)).rejects.toThrow(/could not be read \(not-json\)/);

      // Operator repairs the file out-of-band (e.g. deletes it or fixes the
      // JSON by hand) — simulated here by overwriting it with a valid file.
      await writeFile(JSON.stringify({ disabled: ['github'] }));

      await store.persistEnabled('linear', false);

      const data = await readFile();
      expect((data as { disabled: string[] }).disabled).toContain('github');
      expect((data as { disabled: string[] }).disabled).toContain('linear');
      expect(store.loadEnabled('linear')).toBe(false);
    });
  });

  describe('reading — unreadable path', () => {
    it('records an unreadable failure when the enablement path is a directory, not a file', async () => {
      // Create a directory where the file should be — isFile() returns false.
      const filePath = resolveExtensionEnablementFile(makaioHome);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.mkdir(filePath, { recursive: true });

      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('unreadable');
      // Defaults to all-enabled when the path is unreadable.
      expect(store.loadEnabled('any-ext')).toBeUndefined();
    });

    // A regular file the process may stat but not read reaches the readFile
    // catch, which the directory case above never touches. Root ignores the
    // permission bits, so the assertion would be meaningless there.
    it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
      'records an unreadable failure when the file exists but cannot be read',
      async () => {
        await writeFile('{"disabled":["linear"]}');
        const filePath = resolveExtensionEnablementFile(makaioHome);
        await fs.chmod(filePath, 0o000);

        try {
          const store = await loadExtensionEnablementStore(makaioHome);
          expect(store.readFailure?.reason).toBe('unreadable');
          expect(store.readFailure?.diagnostic).toContain('Could not read enablement file');
          // The disabled name in the unreadable file must not leak into the result.
          expect(store.loadEnabled('linear')).toBeUndefined();
        } finally {
          // Restore permissions so the temp-dir cleanup in afterEach succeeds.
          await fs.chmod(filePath, 0o600);
        }
      },
    );

    it('records an unreadable failure — not a silent missing-file default — when stat fails with a non-ENOENT error', async () => {
      // A disabled name is present on disk: if a non-ENOENT stat failure were
      // (incorrectly) treated like a missing file, this name would silently
      // come back enabled, which is the opposite of what the operator asked for.
      await writeFile('{"disabled":["linear"]}');

      const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      // One-time override — the base implementation (routing to the real
      // `fs.stat`) is restored automatically for every subsequent call.
      statMock.mockRejectedValueOnce(eacces);

      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure?.reason).toBe('unreadable');
      expect(store.readFailure?.diagnostic).toContain('Could not read enablement file');
      // Must not be silently treated as "missing" (all-enabled with no failure).
      expect(store.loadEnabled('linear')).toBeUndefined();
    });

    it('still treats a genuinely missing file as all-enabled with no failure (ENOENT is the only silent path)', async () => {
      // No file was ever written at makaioHome; fs.stat rejects with ENOENT.
      const store = await loadExtensionEnablementStore(makaioHome);
      expect(store.readFailure).toBeUndefined();
      expect(store.loadEnabled('any-ext')).toBeUndefined();
    });
  });
});

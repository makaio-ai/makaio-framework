/**
 * Tests for {@link CodexClientSettings}.
 *
 * All tests exercise real filesystem I/O against a temporary directory tree
 * created per test. No filesystem mocks are used.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexClientSettings } from '../client-settings.js';
import { readHooksJson, readNativeHooksJson, writeHooksJson, writeNativeHooksJson } from './hooks-file-helpers.js';

describe('CodexClientSettings', () => {
  let tmpDir: string;
  let globalHooksPath: string;
  let projectHooksPath: string;
  let settings: CodexClientSettings;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-client-settings-test-'));
    globalHooksPath = path.join(tmpDir, 'global', '.codex', 'hooks.json');
    projectHooksPath = path.join(tmpDir, 'project', '.codex', 'hooks.json');
    settings = new CodexClientSettings({
      globalHooks: globalHooksPath,
      projectHooks: projectHooksPath,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // listHooks
  // -------------------------------------------------------------------------

  describe('listHooks', () => {
    it('returns hooks from both scopes and correct effective concatenation', async () => {
      await writeHooksJson(globalHooksPath, [{ event: 'PreToolUse', command: 'echo global' }]);
      await writeHooksJson(projectHooksPath, [{ event: 'PostToolUse', command: 'echo project' }]);

      const result = await settings.listHooks({});

      expect(result.perScope).toHaveLength(2);
      expect(result.perScope[0]).toMatchObject({
        scope: 'global',
        path: globalHooksPath,
        writable: true,
        hooks: [{ event: 'PreToolUse', command: 'echo global' }],
      });
      expect(result.perScope[1]).toMatchObject({
        scope: 'project',
        path: projectHooksPath,
        writable: true,
        hooks: [{ event: 'PostToolUse', command: 'echo project' }],
      });
      expect(result.effective).toEqual([
        { event: 'PreToolUse', command: 'echo global' },
        { event: 'PostToolUse', command: 'echo project' },
      ]);
    });

    it('returns empty effective list when no config files exist', async () => {
      const result = await settings.listHooks({});

      expect(result.effective).toEqual([]);
      expect(result.perScope[0]?.hooks).toEqual([]);
    });

    it('filters effective hooks by eventName when provided', async () => {
      await writeHooksJson(globalHooksPath, [
        { event: 'PreToolUse', command: 'echo a' },
        { event: 'PostToolUse', command: 'echo b' },
      ]);
      await writeHooksJson(projectHooksPath, [{ event: 'PreToolUse', command: 'echo c' }]);

      const result = await settings.listHooks({ eventName: 'PreToolUse' });

      expect(result.effective).toEqual([
        { event: 'PreToolUse', command: 'echo a' },
        { event: 'PreToolUse', command: 'echo c' },
      ]);
    });

    it.skipIf(process.getuid?.() === 0)('reports writable: false when file and directory are read-only', async () => {
      const readOnlyDir = path.join(tmpDir, 'readonly');
      const readOnlyHooksPath = path.join(readOnlyDir, '.codex', 'hooks.json');
      await writeHooksJson(readOnlyHooksPath, [{ event: 'PreToolUse', command: 'echo ro' }]);
      await fs.chmod(readOnlyHooksPath, 0o444);
      await fs.chmod(path.dirname(readOnlyHooksPath), 0o555);

      const readOnlySettings = new CodexClientSettings({
        globalHooks: readOnlyHooksPath,
        projectHooks: null,
      });

      try {
        const result = await readOnlySettings.listHooks({});
        expect(result.perScope[0]?.writable).toBe(false);
        expect(result.perScope[0]?.hooks).toHaveLength(1);
      } finally {
        await fs.chmod(path.dirname(readOnlyHooksPath), 0o755);
        await fs.chmod(readOnlyHooksPath, 0o644);
      }
    });

    it('omits project scope when pathsOverride has projectHooks: null', async () => {
      const globalOnly = new CodexClientSettings({
        globalHooks: globalHooksPath,
        projectHooks: null,
      });
      await writeHooksJson(globalHooksPath, [{ event: 'PreToolUse', command: 'echo x' }]);

      const result = await globalOnly.listHooks({});

      expect(result.perScope).toHaveLength(1);
      expect(result.perScope[0]?.scope).toBe('global');
    });
  });

  // -------------------------------------------------------------------------
  // addHook
  // -------------------------------------------------------------------------

  describe('addHook', () => {
    it('appends to an existing file', async () => {
      await writeHooksJson(globalHooksPath, [{ event: 'PreToolUse', command: 'echo first' }]);

      const result = await settings.addHook({
        scope: 'global',
        event: 'PostToolUse',
        command: 'echo second',
      });

      expect(result.added).toBe(true);
      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(2);
    });

    it('creates the file when it does not exist', async () => {
      const result = await settings.addHook({
        scope: 'global',
        event: 'PreToolUse',
        command: 'echo new',
      });

      expect(result.added).toBe(true);
      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toEqual([{ event: 'PreToolUse', command: 'echo new' }]);
    });

    it('creates parent directory when absent', async () => {
      // Use a deeply nested path that definitely does not exist
      const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'hooks.json');
      const deepSettings = new CodexClientSettings({
        globalHooks: deepPath,
        projectHooks: null,
      });

      const result = await deepSettings.addHook({
        scope: 'global',
        event: 'PreToolUse',
        command: 'echo deep',
      });

      expect(result.added).toBe(true);
      const hooks = await readHooksJson(deepPath);
      expect(hooks).toHaveLength(1);
    });

    it('is idempotent for identical event + command + matcher', async () => {
      await settings.addHook({
        scope: 'global',
        event: 'PreToolUse',
        matcher: 'bash',
        command: 'echo dup',
      });
      const second = await settings.addHook({
        scope: 'global',
        event: 'PreToolUse',
        matcher: 'bash',
        command: 'echo dup',
      });

      expect(second.added).toBe(false);
      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(1);
    });

    it('is idempotent when both matchers are undefined', async () => {
      await settings.addHook({ scope: 'global', event: 'PreToolUse', command: 'echo x' });
      const second = await settings.addHook({
        scope: 'global',
        event: 'PreToolUse',
        command: 'echo x',
      });

      expect(second.added).toBe(false);
      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(1);
    });

    it('preserves other hooks in the file', async () => {
      await writeHooksJson(globalHooksPath, [
        { event: 'PreToolUse', command: 'echo keep' },
        { event: 'PostToolUse', command: 'echo also-keep' },
      ]);

      await settings.addHook({ scope: 'global', event: 'SessionStart', command: 'echo new' });

      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(3);
      expect(hooks[0]).toMatchObject({ command: 'echo keep' });
      expect(hooks[1]).toMatchObject({ command: 'echo also-keep' });
      expect(hooks[2]).toMatchObject({ command: 'echo new' });
    });

    it('stores optional timeout and matcher fields', async () => {
      await settings.addHook({
        scope: 'global',
        event: 'PreToolUse',
        matcher: 'bash',
        command: 'echo t',
        timeout: 30,
      });

      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks[0]).toEqual({
        event: 'PreToolUse',
        matcher: 'bash',
        command: 'echo t',
        timeout: 30,
      });
    });

    it('writes Codex native event and matcher-group shape', async () => {
      await settings.addHook({
        scope: 'global',
        event: 'PreToolUse',
        matcher: 'Bash',
        command: 'echo native',
        timeout: 30,
      });

      await expect(readNativeHooksJson(globalHooksPath)).resolves.toEqual({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo native', timeout: 30 }],
            },
          ],
        },
      });
    });

    it('preserves native fields outside the targeted hook entry', async () => {
      await writeNativeHooksJson(globalHooksPath, {
        version: 1,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              customGroupField: 'keep-group',
              hooks: [
                {
                  type: 'command',
                  command: 'echo keep',
                  statusMessage: 'Checking Bash command',
                  customHandlerField: 'keep-handler',
                },
              ],
            },
          ],
        },
        customTopLevelField: 'keep-top',
      });

      await settings.addHook({
        scope: 'global',
        event: 'PreToolUse',
        matcher: 'Bash',
        command: 'echo add',
      });

      await expect(readNativeHooksJson(globalHooksPath)).resolves.toMatchObject({
        version: 1,
        customTopLevelField: 'keep-top',
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              customGroupField: 'keep-group',
              hooks: [
                {
                  type: 'command',
                  command: 'echo keep',
                  statusMessage: 'Checking Bash command',
                  customHandlerField: 'keep-handler',
                },
                { type: 'command', command: 'echo add' },
              ],
            },
          ],
        },
      });
    });

    it('does not rewrite the file for duplicate hooks', async () => {
      await settings.addHook({ scope: 'global', event: 'PreToolUse', command: 'echo stable' });
      const before = await fs.readFile(globalHooksPath, 'utf-8');

      const result = await settings.addHook({ scope: 'global', event: 'PreToolUse', command: 'echo stable' });
      const after = await fs.readFile(globalHooksPath, 'utf-8');

      expect(result.added).toBe(false);
      expect(after).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // removeHook
  // -------------------------------------------------------------------------

  describe('removeHook', () => {
    it('removes only hooks matching both event and command substring', async () => {
      await writeHooksJson(globalHooksPath, [
        { event: 'PreToolUse', command: 'run-linter --fix' },
        { event: 'PreToolUse', command: 'run-tests' },
        { event: 'PostToolUse', command: 'run-linter --check' },
      ]);

      const result = await settings.removeHook({
        scope: 'global',
        event: 'PreToolUse',
        match: { commandContains: 'run-linter' },
      });

      expect(result.removed).toBe(1);
      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(2);
      expect(hooks).toContainEqual({ event: 'PreToolUse', command: 'run-tests' });
      expect(hooks).toContainEqual({ event: 'PostToolUse', command: 'run-linter --check' });
    });

    it('returns removed: 0 when nothing matches', async () => {
      await writeHooksJson(globalHooksPath, [{ event: 'PreToolUse', command: 'echo keep' }]);

      const result = await settings.removeHook({
        scope: 'global',
        event: 'PreToolUse',
        match: { commandContains: 'nonexistent' },
      });

      expect(result.removed).toBe(0);
      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(1);
    });

    it('leaves an empty array when the only hook is removed', async () => {
      await writeHooksJson(globalHooksPath, [{ event: 'PreToolUse', command: 'echo only' }]);

      const result = await settings.removeHook({
        scope: 'global',
        event: 'PreToolUse',
        match: { commandContains: 'echo only' },
      });

      expect(result.removed).toBe(1);
      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('throws SyntaxError on corrupt JSON (does not swallow)', async () => {
      await fs.mkdir(path.dirname(globalHooksPath), { recursive: true });
      await fs.writeFile(globalHooksPath, '{ not valid json }', 'utf-8');

      await expect(settings.listHooks({})).rejects.toThrow(SyntaxError);
    });

    it('throws when project scope requested without projectDir', async () => {
      const noProjectSettings = new CodexClientSettings({
        globalHooks: globalHooksPath,
        projectHooks: null,
      });

      await expect(
        noProjectSettings.addHook({ scope: 'project', event: 'PreToolUse', command: 'echo x' }),
      ).rejects.toThrow('Cannot access project scope: projectDir is required');
    });

    it('throws on removeHook with project scope when no projectDir', async () => {
      const noProjectSettings = new CodexClientSettings({
        globalHooks: globalHooksPath,
        projectHooks: null,
      });

      await expect(
        noProjectSettings.removeHook({
          scope: 'project',
          event: 'PreToolUse',
          match: { commandContains: 'echo' },
        }),
      ).rejects.toThrow('Cannot access project scope: projectDir is required');
    });

    it('throws on structurally valid JSON with invalid hook shapes', async () => {
      await fs.mkdir(path.dirname(globalHooksPath), { recursive: true });
      await fs.writeFile(globalHooksPath, JSON.stringify({ hooks: [{ event: 42, command: true }] }), 'utf-8');

      await expect(settings.listHooks({})).rejects.toThrow(/Invalid hooks file/);
    });

    it.skipIf(process.getuid?.() === 0)('throws on permission errors (does not swallow)', async () => {
      // Create the file then make the parent directory non-readable
      await writeHooksJson(globalHooksPath, []);
      await fs.chmod(path.dirname(globalHooksPath), 0o000);

      try {
        await expect(settings.listHooks({})).rejects.toThrow();
      } finally {
        // Restore permissions so cleanup can succeed
        await fs.chmod(path.dirname(globalHooksPath), 0o755);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Write serialization (concurrent mutation safety)
  // -------------------------------------------------------------------------

  describe('write serialization', () => {
    it('serializes concurrent addHook calls to the same file', async () => {
      // Fire 10 concurrent addHook calls — all must land without clobbering
      const events = Array.from({ length: 10 }, (_, i) => `event-${i}`);
      await Promise.all(events.map((event) => settings.addHook({ scope: 'global', event, command: `echo ${event}` })));

      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(10);
    });
  });
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCodeClientSettings } from '../client-settings.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory for a test and return its path.
 * Cleaned up in `afterEach`.
 */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'client-settings-test-'));
}

/**
 * Write a JSON settings file at the given path, creating parent directories.
 * @param filePath - Absolute path to the settings file to write.
 * @param data - Object to serialise as JSON.
 */
async function writeSettings(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/**
 * Read and parse a JSON settings file.
 * @param filePath - Absolute path to the settings file to read.
 * @returns Parsed JSON object.
 */
async function readSettings(filePath: string): Promise<Record<string, unknown>> {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATUS_VALUE_A = { type: 'command' as const, command: 'echo statusA' };
const STATUS_VALUE_B = { type: 'command' as const, command: 'echo statusB' };

const HOOK_A = { type: 'command' as const, command: 'echo hookA' };
const HOOK_B = { type: 'command' as const, command: 'echo hookB' };
const HOOK_TIMEOUT = { type: 'command' as const, command: 'echo hookT', timeout: 5000 };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClaudeCodeClientSettings', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Statusline
  // -------------------------------------------------------------------------

  describe('listStatusline', () => {
    it('returns null value for scopes with no statusLine set', async () => {
      // Use a fresh projectDir so all three scopes are controlled and empty.
      const projectDir = path.join(tmpDir, 'empty-project');
      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listStatusline();

      // The project and local scopes are fully controlled; assert they are null.
      const projectEntry = result.perScope.find((e) => e.scope === 'project');
      const localEntry = result.perScope.find((e) => e.scope === 'local');
      expect(projectEntry).toBeDefined();
      expect(localEntry).toBeDefined();
      expect(projectEntry!.value).toBeNull();
      expect(localEntry!.value).toBeNull();
      expect(result.effective).toBeNull();
    });

    it('last-scope-wins: project overrides user when both have values', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const userPath = path.join(tmpDir, 'home', '.claude', 'settings.json');
      const projectPath = path.join(projectDir, '.claude', 'settings.json');

      await writeSettings(userPath, { statusLine: STATUS_VALUE_A });
      await writeSettings(projectPath, { statusLine: STATUS_VALUE_B });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listStatusline();

      const userEntry = result.perScope.find((e) => e.scope === 'user');
      const projectEntry = result.perScope.find((e) => e.scope === 'project');
      expect(userEntry).toBeDefined();
      expect(projectEntry).toBeDefined();
      expect(userEntry!.value).toEqual(STATUS_VALUE_A);
      expect(projectEntry!.value).toEqual(STATUS_VALUE_B);
      expect(result.effective).toEqual(STATUS_VALUE_B);
    });

    it('returns effective = value from the single scope that has one', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const projectPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(projectPath, { statusLine: STATUS_VALUE_A });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listStatusline();

      const projectEntry = result.perScope.find((e) => e.scope === 'project');
      expect(projectEntry!.value).toEqual(STATUS_VALUE_A);
      // effective should be STATUS_VALUE_A (last non-null wins)
      expect(result.effective).toEqual(STATUS_VALUE_A);
    });
  });

  describe('setStatusline', () => {
    it('creates the file and its parent directory when absent', async () => {
      const projectDir = path.join(tmpDir, 'project');
      // projectDir does not exist yet
      const settings = new ClaudeCodeClientSettings({ projectDir });

      const result = await settings.setStatusline({ scope: 'project', value: STATUS_VALUE_A });

      expect(result.previous).toBeNull();
      expect(result.applied).toEqual(STATUS_VALUE_A);

      const onDisk = await readSettings(path.join(projectDir, '.claude', 'settings.json'));
      expect(onDisk['statusLine']).toEqual(STATUS_VALUE_A);
    });

    it('preserves other keys in the settings file', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        someOtherKey: 'preserve-me',
        statusLine: STATUS_VALUE_A,
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.setStatusline({ scope: 'project', value: STATUS_VALUE_B });

      expect(result.previous).toEqual(STATUS_VALUE_A);
      expect(result.applied).toEqual(STATUS_VALUE_B);

      const onDisk = await readSettings(settingsPath);
      expect(onDisk['someOtherKey']).toBe('preserve-me');
      expect(onDisk['statusLine']).toEqual(STATUS_VALUE_B);
    });

    it('returns previous = null when scope had no statusLine before', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, { unrelated: true });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.setStatusline({ scope: 'project', value: STATUS_VALUE_A });

      expect(result.previous).toBeNull();
    });

    it('throws when project scope requested but no projectDir at construction', async () => {
      const settings = new ClaudeCodeClientSettings(); // no projectDir
      await expect(settings.setStatusline({ scope: 'project', value: STATUS_VALUE_A })).rejects.toThrow(/project/);
    });

    it('throws when local scope requested but no projectDir at construction', async () => {
      const settings = new ClaudeCodeClientSettings();
      await expect(settings.setStatusline({ scope: 'local', value: STATUS_VALUE_A })).rejects.toThrow(/local/);
    });

    it('does not write to disk when setting the same value (no unnecessary I/O)', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, { statusLine: STATUS_VALUE_A });

      const statBefore = await fs.stat(settingsPath);

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await settings.setStatusline({ scope: 'project', value: STATUS_VALUE_A });

      const statAfter = await fs.stat(settingsPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });
  });

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  describe('listHooks', () => {
    it('returns empty effective and perScope when no hooks are set', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listHooks();

      expect(result.effective).toEqual({});
      expect(result.perScope.every((e) => Object.keys(e.events).length === 0)).toBe(true);
    });

    it('additively merges hooks from multiple scopes', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const projectPath = path.join(projectDir, '.claude', 'settings.json');
      const localPath = path.join(projectDir, '.claude', 'settings.local.json');

      await writeSettings(projectPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_A] }] },
      });
      await writeSettings(localPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_B] }] },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listHooks();

      expect(result.effective['PreToolUse']).toHaveLength(2);
      const commands = result.effective['PreToolUse'].flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands).toContain(HOOK_A.command);
      expect(commands).toContain(HOOK_B.command);
    });

    it('filters by eventName when provided', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const projectPath = path.join(projectDir, '.claude', 'settings.json');

      await writeSettings(projectPath, {
        hooks: {
          PreToolUse: [{ hooks: [HOOK_A] }],
          PostToolUse: [{ hooks: [HOOK_B] }],
        },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listHooks({ eventName: 'PreToolUse' });

      expect(result.effective['PreToolUse']).toBeDefined();
      expect(result.effective['PostToolUse']).toBeUndefined();
      expect(result.perScope.every((e) => e.events['PostToolUse'] === undefined)).toBe(true);
    });
  });

  describe('addHook', () => {
    it('creates a new matcher group and appends hook', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settings = new ClaudeCodeClientSettings({ projectDir });

      const result = await settings.addHook({
        scope: 'project',
        eventName: 'PreToolUse',
        hook: HOOK_A,
      });

      expect(result.added).toBe(true);
      const onDisk = await readSettings(path.join(projectDir, '.claude', 'settings.json'));
      const groups = (onDisk['hooks'] as Record<string, unknown>)['PreToolUse'] as unknown[];
      expect(groups).toHaveLength(1);
    });

    it('appends to an existing matcher group', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_A] }] },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.addHook({
        scope: 'project',
        eventName: 'PreToolUse',
        hook: HOOK_B,
      });

      expect(result.added).toBe(true);
      const onDisk = await readSettings(settingsPath);
      const groups = (onDisk['hooks'] as Record<string, unknown[]>)['PreToolUse'] as Array<{
        hooks: unknown[];
      }>;
      expect(groups[0].hooks).toHaveLength(2);
    });

    it('is idempotent for an identical hook (returns added: false)', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_A] }] },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.addHook({
        scope: 'project',
        eventName: 'PreToolUse',
        hook: HOOK_A,
      });

      expect(result.added).toBe(false);

      // File must not have grown
      const onDisk = await readSettings(settingsPath);
      const groups = (onDisk['hooks'] as Record<string, unknown[]>)['PreToolUse'] as Array<{
        hooks: unknown[];
      }>;
      expect(groups[0].hooks).toHaveLength(1);
    });

    it('does not write to disk when adding an identical hook (no unnecessary I/O)', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_A] }] },
      });

      // Capture mtime before the no-op call
      const statBefore = await fs.stat(settingsPath);

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await settings.addHook({
        scope: 'project',
        eventName: 'PreToolUse',
        hook: HOOK_A,
      });

      // mtime must not have advanced — the file was not rewritten
      const statAfter = await fs.stat(settingsPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });

    it('distinguishes hooks with different timeout values', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_TIMEOUT] }] },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      // Same command, different timeout → not identical
      const hookDifferentTimeout = { type: 'command' as const, command: HOOK_TIMEOUT.command, timeout: 9999 };
      const result = await settings.addHook({
        scope: 'project',
        eventName: 'PreToolUse',
        hook: hookDifferentTimeout,
      });

      expect(result.added).toBe(true);
    });

    it('preserves other events in the file', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PostToolUse: [{ hooks: [HOOK_B] }] },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await settings.addHook({
        scope: 'project',
        eventName: 'PreToolUse',
        hook: HOOK_A,
      });

      const onDisk = await readSettings(settingsPath);
      const hooks = onDisk['hooks'] as Record<string, unknown>;
      expect(hooks['PostToolUse']).toBeDefined();
      expect(hooks['PreToolUse']).toBeDefined();
    });

    it('preserves malformed non-target hook events during add', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      const malformedEvent = [{ matcher: 42, hooks: [HOOK_B] }];
      await writeSettings(settingsPath, {
        hooks: {
          MalformedEvent: malformedEvent,
        },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await settings.addHook({
        scope: 'project',
        eventName: 'PreToolUse',
        hook: HOOK_A,
      });

      const onDisk = await readSettings(settingsPath);
      const hooks = onDisk['hooks'] as Record<string, unknown>;
      expect(hooks['MalformedEvent']).toEqual(malformedEvent);
      expect(hooks['PreToolUse']).toBeDefined();
    });

    it('uses matcher to find the right group', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [HOOK_A] },
            { matcher: 'Read', hooks: [HOOK_B] },
          ],
        },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const hookC = { type: 'command' as const, command: 'echo hookC' };
      await settings.addHook({
        scope: 'project',
        eventName: 'PreToolUse',
        matcher: 'Bash',
        hook: hookC,
      });

      const onDisk = await readSettings(settingsPath);
      const groups = (onDisk['hooks'] as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>)['PreToolUse'];
      const bashGroup = groups.find((g) => g.matcher === 'Bash');
      const readGroup = groups.find((g) => g.matcher === 'Read');
      expect(bashGroup!.hooks).toHaveLength(2);
      expect(readGroup!.hooks).toHaveLength(1);
    });
  });

  describe('removeHook', () => {
    it('removes hooks matching the command substring', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: {
          PreToolUse: [{ hooks: [HOOK_A, HOOK_B] }],
        },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.removeHook({
        scope: 'project',
        eventName: 'PreToolUse',
        match: { commandContains: 'hookA' },
      });

      expect(result.removed).toBe(1);

      const onDisk = await readSettings(settingsPath);
      const groups = (onDisk['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>)['PreToolUse'];
      expect(groups[0].hooks).toHaveLength(1);
      expect(groups[0].hooks[0].command).toBe(HOOK_B.command);
    });

    it('prunes empty groups after removal', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: {
          PreToolUse: [{ hooks: [HOOK_A] }],
        },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.removeHook({
        scope: 'project',
        eventName: 'PreToolUse',
        match: { commandContains: 'hookA' },
      });

      expect(result.removed).toBe(1);

      const onDisk = await readSettings(settingsPath);
      const hooks = onDisk['hooks'] as Record<string, unknown>;
      // Event entry should be pruned entirely
      expect(hooks['PreToolUse']).toBeUndefined();
    });

    it('prunes empty events after all groups removed', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        otherKey: 'keep',
        hooks: {
          PreToolUse: [{ hooks: [HOOK_A, HOOK_B] }],
          PostToolUse: [{ hooks: [HOOK_A] }],
        },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await settings.removeHook({
        scope: 'project',
        eventName: 'PreToolUse',
        match: { commandContains: 'echo' },
      });

      const onDisk = await readSettings(settingsPath);
      const hooks = onDisk['hooks'] as Record<string, unknown>;
      expect(hooks['PreToolUse']).toBeUndefined();
      expect(hooks['PostToolUse']).toBeDefined();
      expect(onDisk['otherKey']).toBe('keep');
    });

    it('preserves malformed entries in the target event during remove', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      const malformedGroup = { matcher: 42, hooks: [HOOK_B] };
      await writeSettings(settingsPath, {
        hooks: {
          PreToolUse: [malformedGroup, { hooks: [HOOK_A] }],
        },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.removeHook({
        scope: 'project',
        eventName: 'PreToolUse',
        match: { commandContains: 'hookA' },
      });

      expect(result.removed).toBe(1);
      const onDisk = await readSettings(settingsPath);
      const hooks = onDisk['hooks'] as Record<string, unknown[]>;
      expect(hooks['PreToolUse']).toEqual([malformedGroup]);
    });

    it('returns removed = 0 when no hooks match', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_A] }] },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.removeHook({
        scope: 'project',
        eventName: 'PreToolUse',
        match: { commandContains: 'no-such-command' },
      });

      expect(result.removed).toBe(0);
    });

    it('returns removed = 0 when event does not exist', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.removeHook({
        scope: 'project',
        eventName: 'NonExistentEvent',
        match: { commandContains: 'something' },
      });

      expect(result.removed).toBe(0);
    });

    it('does not write to disk when no hooks match', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_A] }] },
      });

      // Capture mtime before the no-op call
      const statBefore = await fs.stat(settingsPath);

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await settings.removeHook({
        scope: 'project',
        eventName: 'PreToolUse',
        match: { commandContains: 'no-such-command' },
      });

      // mtime must not have advanced — the file was not rewritten
      const statAfter = await fs.stat(settingsPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });

    it('does not create the settings file when removing a hook from a non-existent event', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      // No settings file written — projectDir does not even exist yet

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await settings.removeHook({
        scope: 'project',
        eventName: 'NonExistentEvent',
        match: { commandContains: 'something' },
      });

      // The settings file must not have been created
      await expect(fs.access(settingsPath)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------

  describe('listPlugins', () => {
    it('returns no extensions from controlled scopes when enabledPlugins is absent', async () => {
      // Use a fresh projectDir so project/local scopes are fully controlled.
      const projectDir = path.join(tmpDir, 'empty-extensions');
      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listPlugins();

      expect(result.plugins).toEqual([]);
    });

    it('aggregates extensions across scopes', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const projectPath = path.join(projectDir, '.claude', 'settings.json');
      const localPath = path.join(projectDir, '.claude', 'settings.local.json');

      await writeSettings(projectPath, {
        enabledPlugins: { 'plugin-a': true },
      });
      await writeSettings(localPath, {
        enabledPlugins: { 'plugin-b': false },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listPlugins();

      const names = result.plugins.map((p) => p.name);
      expect(names).toContain('plugin-a');
      expect(names).toContain('plugin-b');

      const pluginA = result.plugins.find((p) => p.name === 'plugin-a');
      const pluginB = result.plugins.find((p) => p.name === 'plugin-b');
      expect(pluginA!.enabled).toBe(true);
      expect(pluginA!.scope).toBe('project');
      expect(pluginB!.enabled).toBe(false);
      expect(pluginB!.scope).toBe('local');
    });

    it('uses the narrowest scope when a plugin is declared more than once', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const userPath = path.join(tmpDir, 'home', '.claude', 'settings.json');
      const projectPath = path.join(projectDir, '.claude', 'settings.json');
      const localPath = path.join(projectDir, '.claude', 'settings.local.json');

      await writeSettings(userPath, {
        enabledPlugins: { 'plugin-a': true },
      });
      await writeSettings(projectPath, {
        enabledPlugins: { 'plugin-a': true },
      });
      await writeSettings(localPath, {
        enabledPlugins: { 'plugin-a': false },
      });

      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listPlugins();

      expect(result.plugins).toEqual([{ name: 'plugin-a', enabled: false, scope: 'local' }]);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('throws on corrupt JSON (not swallowed)', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, '{ this is not valid json }', 'utf-8');

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await expect(settings.listStatusline()).rejects.toThrow();
    });

    it('throws on non-object JSON (array at top level)', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, '[1, 2, 3]', 'utf-8');

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await expect(settings.listStatusline()).rejects.toThrow(/non-object.*array/);
    });

    it('throws on non-object JSON (number at top level)', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, '42', 'utf-8');

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await expect(settings.listStatusline()).rejects.toThrow(/non-object/);
    });

    it('throws on permission errors (not swallowed)', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, { statusLine: STATUS_VALUE_A });
      await fs.chmod(settingsPath, 0o000);

      const settings = new ClaudeCodeClientSettings({ projectDir });
      await expect(settings.listStatusline()).rejects.toThrow();

      // Restore permissions so afterEach cleanup can remove the file
      await fs.chmod(settingsPath, 0o644);
    });

    it('does not throw on ENOENT (missing file treated as empty scope)', async () => {
      const projectDir = path.join(tmpDir, 'missing-project');
      // No files written — project dir does not even exist
      const settings = new ClaudeCodeClientSettings({ projectDir });
      const result = await settings.listStatusline();

      // project and local scopes are controlled and absent → both null
      const projectEntry = result.perScope.find((e) => e.scope === 'project');
      const localEntry = result.perScope.find((e) => e.scope === 'local');
      expect(projectEntry!.value).toBeNull();
      expect(localEntry!.value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent writes (mutex)
  // -------------------------------------------------------------------------

  describe('concurrent writes', () => {
    it('serialises concurrent writes across instances without data loss', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const settingsA = new ClaudeCodeClientSettings({ projectDir });
      const settingsB = new ClaudeCodeClientSettings({ projectDir });

      // Kick off multiple addHook calls concurrently across two instances
      const hookCommands = Array.from({ length: 5 }, (_, i) => `echo hook${i}`);
      await Promise.all(
        hookCommands.map((command, i) =>
          (i % 2 === 0 ? settingsA : settingsB).addHook({
            scope: 'project',
            eventName: 'PreToolUse',
            hook: { type: 'command', command },
          }),
        ),
      );

      const result = await settingsA.listHooks({ eventName: 'PreToolUse' });
      const allCommands = result.effective['PreToolUse']?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
      // All hooks should be present with no overwrites
      expect(allCommands.sort()).toEqual(hookCommands.sort());
    });
  });
});

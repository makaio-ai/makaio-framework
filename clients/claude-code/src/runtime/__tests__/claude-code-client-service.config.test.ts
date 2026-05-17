/**
 * Integration tests for the `config.*` subjects wired in
 * {@link ClaudeCodeClientService}.
 *
 * Each test writes real settings files to a temp directory, makes a bus
 * request through the fully-initialised service, and asserts on the response.
 * This verifies the full round-trip: subject registration → handler dispatch →
 * ClaudeCodeClientSettings read/write → bus response.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClaudeCodeClientService } from '../claude-code-client-service.js';
import { ClaudeCodeClientSubjects } from '../namespace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory and return its path.
 * Cleaned up in `afterEach`.
 * @returns Absolute path to the created temp directory.
 */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-svc-config-test-'));
}

/**
 * Write a JSON settings file at the given path, creating parent directories.
 * @param filePath - Absolute path to the settings file.
 * @param data - Object to serialise as JSON.
 */
async function writeSettings(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/**
 * Read and parse a JSON settings file.
 * @param filePath - Absolute path to the settings file.
 * @returns Parsed JSON object.
 */
async function readSettings(filePath: string): Promise<Record<string, unknown>> {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATUS_VALUE = { type: 'command' as const, command: 'echo status' };
const HOOK_DEF = { type: 'command' as const, command: 'echo my-hook' };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ClaudeCodeClientService — config subjects', () => {
  let bus: IMakaioBus;
  let service: ClaudeCodeClientService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
    bus = createBusInstance();
    service = new ClaudeCodeClientService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // config.statusline.list
  // -------------------------------------------------------------------------

  describe('config.statusline.list', () => {
    it('round-trips: returns null for controlled scopes when no settings file exists', async () => {
      const projectDir = path.join(tmpDir, 'empty-project');

      const result = await bus.request(ClaudeCodeClientSubjects.config.statusline.list, {
        projectDir,
      });

      expect(result.effective).toBeNull();
      expect(result.perScope).toHaveLength(3);
      expect(result.perScope.every((e) => e.value === null)).toBe(true);
    });

    it('round-trips: returns effective value when project settings file has statusLine', async () => {
      const projectDir = path.join(tmpDir, 'project');
      const projectSettingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(projectSettingsPath, { statusLine: STATUS_VALUE });

      const result = await bus.request(ClaudeCodeClientSubjects.config.statusline.list, {
        projectDir,
      });

      expect(result.effective).toEqual(STATUS_VALUE);
      const projectEntry = result.perScope.find((e) => e.scope === 'project');
      expect(projectEntry?.value).toEqual(STATUS_VALUE);
    });
  });

  // -------------------------------------------------------------------------
  // config.statusline.set
  // -------------------------------------------------------------------------

  describe('config.statusline.set', () => {
    it('round-trips: writes to project scope and returns previous + applied', async () => {
      const projectDir = path.join(tmpDir, 'project');

      const result = await bus.request(ClaudeCodeClientSubjects.config.statusline.set, {
        scope: 'project',
        projectDir,
        value: STATUS_VALUE,
      });

      expect(result.previous).toBeNull();
      expect(result.applied).toEqual(STATUS_VALUE);

      // Verify the file was actually written
      const onDisk = await readSettings(path.join(projectDir, '.claude', 'settings.json'));
      expect(onDisk['statusLine']).toEqual(STATUS_VALUE);
    });
  });

  // -------------------------------------------------------------------------
  // config.hooks.list
  // -------------------------------------------------------------------------

  describe('config.hooks.list', () => {
    it('round-trips: returns empty effective hooks when no settings file exists', async () => {
      const projectDir = path.join(tmpDir, 'empty-hooks-project');

      const result = await bus.request(ClaudeCodeClientSubjects.config.hooks.list, {
        projectDir,
      });

      expect(result.effective).toEqual({});
      expect(result.perScope.every((e) => Object.keys(e.events).length === 0)).toBe(true);
    });

    it('round-trips: returns hooks from project settings file', async () => {
      const projectDir = path.join(tmpDir, 'hooks-project');
      const projectSettingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(projectSettingsPath, {
        hooks: {
          PreToolUse: [{ hooks: [HOOK_DEF] }],
        },
      });

      const result = await bus.request(ClaudeCodeClientSubjects.config.hooks.list, {
        projectDir,
      });

      expect(result.effective['PreToolUse']).toHaveLength(1);
      expect(result.effective['PreToolUse'][0].hooks[0].command).toBe(HOOK_DEF.command);
    });
  });

  // -------------------------------------------------------------------------
  // config.hooks.add
  // -------------------------------------------------------------------------

  describe('config.hooks.add', () => {
    it('round-trips: adds a hook and returns added: true', async () => {
      const projectDir = path.join(tmpDir, 'add-hook-project');

      const result = await bus.request(ClaudeCodeClientSubjects.config.hooks.add, {
        scope: 'project',
        projectDir,
        eventName: 'PreToolUse',
        hook: HOOK_DEF,
      });

      expect(result.added).toBe(true);

      // Verify the hook was written to disk
      const onDisk = await readSettings(path.join(projectDir, '.claude', 'settings.json'));
      const hooksMap = onDisk['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      expect(hooksMap['PreToolUse']).toHaveLength(1);
      expect(hooksMap['PreToolUse'][0].hooks[0].command).toBe(HOOK_DEF.command);
    });

    it('round-trips: returns added: false when the identical hook already exists', async () => {
      const projectDir = path.join(tmpDir, 'idempotent-hook-project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_DEF] }] },
      });

      const result = await bus.request(ClaudeCodeClientSubjects.config.hooks.add, {
        scope: 'project',
        projectDir,
        eventName: 'PreToolUse',
        hook: HOOK_DEF,
      });

      expect(result.added).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // config.hooks.remove
  // -------------------------------------------------------------------------

  describe('config.hooks.remove', () => {
    it('round-trips: removes matching hooks and returns removed count', async () => {
      const projectDir = path.join(tmpDir, 'remove-hook-project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: {
          PreToolUse: [{ hooks: [HOOK_DEF, { type: 'command', command: 'echo other-hook' }] }],
        },
      });

      const result = await bus.request(ClaudeCodeClientSubjects.config.hooks.remove, {
        scope: 'project',
        projectDir,
        eventName: 'PreToolUse',
        match: { commandContains: 'my-hook' },
      });

      expect(result.removed).toBe(1);

      const onDisk = await readSettings(settingsPath);
      const hooksMap = onDisk['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      expect(hooksMap['PreToolUse'][0].hooks).toHaveLength(1);
      expect(hooksMap['PreToolUse'][0].hooks[0].command).toBe('echo other-hook');
    });

    it('round-trips: returns removed = 0 when no hooks match', async () => {
      const projectDir = path.join(tmpDir, 'no-remove-project');
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(settingsPath, {
        hooks: { PreToolUse: [{ hooks: [HOOK_DEF] }] },
      });

      const result = await bus.request(ClaudeCodeClientSubjects.config.hooks.remove, {
        scope: 'project',
        projectDir,
        eventName: 'PreToolUse',
        match: { commandContains: 'no-such-command' },
      });

      expect(result.removed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // config.extensions.list
  // -------------------------------------------------------------------------

  describe('config.plugins.list', () => {
    it('round-trips: returns empty extensions list when no settings exist', async () => {
      const projectDir = path.join(tmpDir, 'empty-extensions-project');

      const result = await bus.request(ClaudeCodeClientSubjects.config.plugins.list, {
        projectDir,
      });

      expect(result.plugins).toEqual([]);
    });

    it('round-trips: returns extensions from project settings file', async () => {
      const projectDir = path.join(tmpDir, 'extensions-project');
      const projectSettingsPath = path.join(projectDir, '.claude', 'settings.json');
      await writeSettings(projectSettingsPath, {
        enabledPlugins: {
          'my-plugin': true,
          'disabled-plugin': false,
        },
      });

      const result = await bus.request(ClaudeCodeClientSubjects.config.plugins.list, {
        projectDir,
      });

      const names = result.plugins.map((p) => p.name);
      expect(names).toContain('my-plugin');
      expect(names).toContain('disabled-plugin');

      const myPlugin = result.plugins.find((p) => p.name === 'my-plugin');
      const disabledPlugin = result.plugins.find((p) => p.name === 'disabled-plugin');
      expect(myPlugin?.enabled).toBe(true);
      expect(myPlugin?.scope).toBe('project');
      expect(disabledPlugin?.enabled).toBe(false);
      expect(disabledPlugin?.scope).toBe('project');
    });

    it('round-trips: aggregates extensions across project and local scopes', async () => {
      const projectDir = path.join(tmpDir, 'multi-scope-extensions-project');
      const projectSettingsPath = path.join(projectDir, '.claude', 'settings.json');
      const localSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');

      await writeSettings(projectSettingsPath, {
        enabledPlugins: { 'plugin-a': true },
      });
      await writeSettings(localSettingsPath, {
        enabledPlugins: { 'plugin-b': false },
      });

      const result = await bus.request(ClaudeCodeClientSubjects.config.plugins.list, {
        projectDir,
      });

      const controlledPlugins = result.plugins.filter((p) => p.scope === 'project' || p.scope === 'local');
      const names = controlledPlugins.map((p) => p.name);
      expect(names).toContain('plugin-a');
      expect(names).toContain('plugin-b');

      const pluginA = controlledPlugins.find((p) => p.name === 'plugin-a');
      const pluginB = controlledPlugins.find((p) => p.name === 'plugin-b');
      expect(pluginA?.scope).toBe('project');
      expect(pluginB?.scope).toBe('local');
    });

    it('round-trips: local plugin declarations override project declarations', async () => {
      const projectDir = path.join(tmpDir, 'overridden-extensions-project');
      const projectSettingsPath = path.join(projectDir, '.claude', 'settings.json');
      const localSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');

      await writeSettings(projectSettingsPath, {
        enabledPlugins: { 'plugin-a': true },
      });
      await writeSettings(localSettingsPath, {
        enabledPlugins: { 'plugin-a': false },
      });

      const result = await bus.request(ClaudeCodeClientSubjects.config.plugins.list, {
        projectDir,
      });

      expect(result.plugins).toEqual([{ name: 'plugin-a', enabled: false, scope: 'local' }]);
    });
  });

  // -------------------------------------------------------------------------
  // managed config lifecycle subjects
  // -------------------------------------------------------------------------

  describe('managed config lifecycle subjects', () => {
    it('round-trips config.prime through the service handler', async () => {
      const configDir = path.join(tmpDir, 'prime-config');

      const result = await bus.request(ClaudeCodeClientSubjects.config.prime, {
        clientId: 'claude-code',
        configDir,
        phase: 'managed-install',
      });

      expect(result).toEqual({ primed: true });
      const settings = await readSettings(path.join(configDir, 'settings.json'));
      expect(settings['env']).toEqual({ DISABLE_AUTOUPDATER: '1' });
    });

    it('round-trips sessionConfig.setup through the service handler', async () => {
      const baseConfigDir = path.join(tmpDir, 'base-config');
      const sessionDir = path.join(tmpDir, 'session-config');
      await fs.mkdir(baseConfigDir, { recursive: true });
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(baseConfigDir, 'settings.json'), '{"theme":"dark"}', 'utf-8');

      const result = await bus.request(ClaudeCodeClientSubjects.sessionConfig.setup, {
        sessionDir,
        baseConfigDir,
        platform: 'linux',
        configInheritance: 'full',
      });

      expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: sessionDir });
      const settings = await readSettings(path.join(sessionDir, 'settings.json'));
      expect(settings).toMatchObject({ theme: 'dark', env: { DISABLE_AUTOUPDATER: '1' } });
    });
  });

  // -------------------------------------------------------------------------
  // wiring subjects
  // -------------------------------------------------------------------------

  describe('wiring subjects', () => {
    it('round-trips: lists, applies, and removes Claude Code wiring through service handlers', async () => {
      const projectDir = path.join(tmpDir, 'wiring-project');

      const before = await bus.request(ClaudeCodeClientSubjects.wiring.list, {
        projectDir,
        makaioCommand: 'makaio-dev',
      });
      expect(before.entries.length).toBeGreaterThan(0);
      expect(before.entries.every((entry) => entry.installed === false)).toBe(true);

      const applied = await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
        scope: 'project',
        projectDir,
        makaioCommand: 'makaio-dev',
      });
      expect(applied.applied).toBeGreaterThan(0);

      const afterApply = await bus.request(ClaudeCodeClientSubjects.wiring.list, {
        projectDir,
        makaioCommand: 'makaio-dev',
      });
      expect(afterApply.entries.some((entry) => entry.group === 'session-events' && entry.installed)).toBe(true);
      expect(afterApply.entries.find((entry) => entry.name === 'statusline')?.installed).toBe(true);

      const onDiskAfterApply = await readSettings(path.join(projectDir, '.claude', 'settings.json'));
      expect(onDiskAfterApply['hooks']).toBeDefined();
      expect(onDiskAfterApply['statusLine']).toEqual({
        type: 'command',
        command: 'makaio-dev claude statusline',
      });

      const removed = await bus.request(ClaudeCodeClientSubjects.wiring.remove, {
        scope: 'project',
        projectDir,
      });
      expect(removed.removed).toBeGreaterThan(0);

      const afterRemove = await bus.request(ClaudeCodeClientSubjects.wiring.list, {
        projectDir,
        makaioCommand: 'makaio-dev',
      });
      expect(afterRemove.entries.every((entry) => entry.installed === false)).toBe(true);
    });
  });
});

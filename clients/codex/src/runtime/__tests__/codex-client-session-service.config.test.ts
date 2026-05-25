/**
 * Integration tests for the config management request handlers wired up in
 * {@link CodexClientSessionService}.
 *
 * All tests exercise real filesystem I/O against a temporary directory tree
 * and real bus request dispatch — no mocks are used.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/subsystem-client';
import { CodexClientSettings } from '../client-settings.js';
import { CodexClientSessionService } from '../codex-client-session-service.js';
import { CodexClientSubjects } from '../namespace.js';
import { readHooksJson, writeHooksJson } from './hooks-file-helpers.js';

describe('CodexClientSessionService — config handler round-trips', () => {
  let bus: IMakaioBus;
  let service: CodexClientSessionService | undefined;
  let tmpDir: string;
  let globalHooksPath: string;
  let projectHooksPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-service-config-test-'));
    globalHooksPath = path.join(tmpDir, 'global', '.codex', 'hooks.json');
    projectHooksPath = path.join(tmpDir, 'project', '.codex', 'hooks.json');

    // pathsOverride wires both scopes to temp-dir paths directly, so tests
    // exercise scope merging without depending on user-home config paths.
    // Project-scope writes still include projectDir because the bus contract
    // requires production-shaped requests before the settings layer runs.
    const settings = new CodexClientSettings({
      globalHooks: globalHooksPath,
      projectHooks: projectHooksPath,
    });

    bus = createBusInstance();
    const svc = new CodexClientSessionService(bus, settings);
    await svc.init();
    service = svc;
  });

  afterEach(async () => {
    if (service !== undefined) {
      await service.destroy();
      service = undefined;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // config.hooks.list
  // ---------------------------------------------------------------------------

  describe('config.hooks.list round-trip', () => {
    it('returns an empty effective list when no config files exist', async () => {
      const result = await bus.request(CodexClientSubjects.config.hooks.list, {});

      expect(result.effective).toEqual([]);
      expect(result.perScope).toHaveLength(2);
      expect(result.perScope[0]?.scope).toBe('global');
      expect(result.perScope[1]?.scope).toBe('project');
    });

    it('returns hooks written to disk in the effective list', async () => {
      await writeHooksJson(globalHooksPath, [{ event: 'PreToolUse', command: 'echo global' }]);
      await writeHooksJson(projectHooksPath, [{ event: 'PostToolUse', command: 'echo project' }]);

      const result = await bus.request(CodexClientSubjects.config.hooks.list, {});

      expect(result.effective).toHaveLength(2);
      expect(result.effective).toContainEqual({ event: 'PreToolUse', command: 'echo global' });
      expect(result.effective).toContainEqual({ event: 'PostToolUse', command: 'echo project' });
    });

    it('filters by eventName when provided', async () => {
      await writeHooksJson(globalHooksPath, [
        { event: 'PreToolUse', command: 'echo a' },
        { event: 'PostToolUse', command: 'echo b' },
      ]);

      const result = await bus.request(CodexClientSubjects.config.hooks.list, {
        eventName: 'PreToolUse',
      });

      expect(result.effective).toHaveLength(1);
      expect(result.effective[0]).toMatchObject({ event: 'PreToolUse', command: 'echo a' });
    });
  });

  // ---------------------------------------------------------------------------
  // config.hooks.add
  // ---------------------------------------------------------------------------

  describe('config.hooks.add round-trip', () => {
    it('writes the hook to disk and returns added: true', async () => {
      const result = await bus.request(CodexClientSubjects.config.hooks.add, {
        scope: 'global',
        event: 'PreToolUse',
        command: 'echo new-hook',
      });

      expect(result.added).toBe(true);

      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toMatchObject({ event: 'PreToolUse', command: 'echo new-hook' });
    });

    it('returns added: false for a duplicate hook entry', async () => {
      await bus.request(CodexClientSubjects.config.hooks.add, {
        scope: 'global',
        event: 'PreToolUse',
        command: 'echo dup',
      });

      const second = await bus.request(CodexClientSubjects.config.hooks.add, {
        scope: 'global',
        event: 'PreToolUse',
        command: 'echo dup',
      });

      expect(second.added).toBe(false);

      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(1);
    });

    it('creates the config file when it does not exist', async () => {
      const result = await bus.request(CodexClientSubjects.config.hooks.add, {
        scope: 'project',
        projectDir: tmpDir,
        event: 'SessionStart',
        command: 'echo project-hook',
      });

      expect(result.added).toBe(true);

      const hooks = await readHooksJson(projectHooksPath);
      expect(hooks).toEqual([{ event: 'SessionStart', command: 'echo project-hook' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // config.hooks.remove
  // ---------------------------------------------------------------------------

  describe('config.hooks.remove round-trip', () => {
    it('removes matching hooks and returns the correct count', async () => {
      await writeHooksJson(globalHooksPath, [
        { event: 'PreToolUse', command: 'run-linter --fix' },
        { event: 'PreToolUse', command: 'run-tests' },
      ]);

      const result = await bus.request(CodexClientSubjects.config.hooks.remove, {
        scope: 'global',
        event: 'PreToolUse',
        match: { commandContains: 'run-linter' },
      });

      expect(result.removed).toBe(1);

      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toMatchObject({ command: 'run-tests' });
    });

    it('returns removed: 0 when no hooks match the filter', async () => {
      await writeHooksJson(globalHooksPath, [{ event: 'PreToolUse', command: 'echo keep' }]);

      const result = await bus.request(CodexClientSubjects.config.hooks.remove, {
        scope: 'global',
        event: 'PreToolUse',
        match: { commandContains: 'nonexistent' },
      });

      expect(result.removed).toBe(0);
    });

    it('add then remove round-trip leaves the correct hook count', async () => {
      await bus.request(CodexClientSubjects.config.hooks.add, {
        scope: 'global',
        event: 'PreToolUse',
        command: 'echo hook-one',
      });
      await bus.request(CodexClientSubjects.config.hooks.add, {
        scope: 'global',
        event: 'PreToolUse',
        command: 'echo hook-two',
      });

      const removeResult = await bus.request(CodexClientSubjects.config.hooks.remove, {
        scope: 'global',
        event: 'PreToolUse',
        match: { commandContains: 'hook-one' },
      });

      expect(removeResult.removed).toBe(1);

      const hooks = await readHooksJson(globalHooksPath);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toMatchObject({ command: 'echo hook-two' });
    });
  });

  // ---------------------------------------------------------------------------
  // projectDir production path
  // ---------------------------------------------------------------------------

  describe('projectDir production path (no pathsOverride)', () => {
    it('resolves project scope from projectDir in the request payload', async () => {
      // Construct a settings instance without pathsOverride so projectDir
      // flows through resolveCodexSettingsPaths() — the production path.
      await service!.destroy();
      service = undefined;

      const prodSettings = new CodexClientSettings();
      const svc = new CodexClientSessionService(bus, prodSettings);
      await svc.init();
      service = svc;

      const result = await bus.request(CodexClientSubjects.config.hooks.add, {
        scope: 'project',
        projectDir: tmpDir,
        event: 'PreToolUse',
        command: 'echo production-path',
      });

      expect(result.added).toBe(true);
      const hooks = await readHooksJson(path.join(tmpDir, '.codex', 'hooks.json'));
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toMatchObject({ command: 'echo production-path' });
    });
  });

  // ---------------------------------------------------------------------------
  // managed config lifecycle subjects
  // ---------------------------------------------------------------------------

  describe('managed config lifecycle subjects', () => {
    it('round-trips config.prime through the service handler', async () => {
      const configDir = path.join(tmpDir, 'prime-config');

      const result = await bus.request(CodexClientSubjects.config.prime, {
        clientId: 'codex',
        configDir,
        phase: 'managed-install',
      });

      expect(result).toEqual({ primed: true });
      await expect(fs.readFile(path.join(configDir, 'config.toml'), 'utf-8')).resolves.toContain(
        'check_for_update_on_startup = false',
      );
    });

    it('round-trips sessionConfig.setup through the service handler', async () => {
      const baseConfigDir = path.join(tmpDir, 'base-config');
      const sessionDir = path.join(tmpDir, 'session-config');
      await fs.mkdir(baseConfigDir, { recursive: true });
      await fs.writeFile(path.join(baseConfigDir, 'config.toml'), 'model = "gpt-5"\n', 'utf-8');

      const result = await bus.request(CodexClientSubjects.sessionConfig.setup, {
        sessionDir,
        baseConfigDir,
        platform: 'linux',
        configInheritance: 'full',
      });

      expect(result.env).toEqual({ CODEX_HOME: sessionDir });
      const configToml = await fs.readFile(path.join(sessionDir, 'config.toml'), 'utf-8');
      expect(configToml).toContain('model = "gpt-5"');
      expect(configToml).toContain('check_for_update_on_startup = false');
    });
  });

  // ---------------------------------------------------------------------------
  // managed config resolution
  // ---------------------------------------------------------------------------

  describe('managed config resolution', () => {
    it('uses client.resolveBinary configDir for global hook config when no settings override is injected', async () => {
      await service!.destroy();
      const managedConfigDir = path.join(tmpDir, 'managed-codex-config');
      bus.on(ClientSubjects.resolveBinary, (ctx) => {
        expect(ctx.payload.clientId).toBe('codex');
        ctx.setResult({
          binaryPath: null,
          env: { CODEX_HOME: managedConfigDir },
          configDir: managedConfigDir,
          source: 'managed',
          version: '0.130.0',
        });
      });
      const svc = new CodexClientSessionService(bus);
      await svc.init();
      service = svc;

      const result = await bus.request(CodexClientSubjects.config.hooks.list, {});

      expect(result.perScope[0]?.path).toBe(path.join(managedConfigDir, 'hooks.json'));
    });

    it('uses client.resolveBinary configDir when listing installed wiring', async () => {
      await service!.destroy();
      const managedConfigDir = path.join(tmpDir, 'managed-codex-config');
      await writeHooksJson(path.join(managedConfigDir, 'hooks.json'), [
        {
          event: 'SessionStart',
          command: 'makaio --debounce-failure hook received codex SessionStart',
        },
      ]);
      bus.on(ClientSubjects.resolveBinary, (ctx) => {
        expect(ctx.payload.clientId).toBe('codex');
        ctx.setResult({
          binaryPath: null,
          env: { CODEX_HOME: managedConfigDir },
          configDir: managedConfigDir,
          source: 'managed',
          version: '0.130.0',
        });
      });
      const svc = new CodexClientSessionService(bus);
      await svc.init();
      service = svc;

      const result = await bus.request(CodexClientSubjects.wiring.list, {
        makaioCommand: 'makaio',
      });

      const sessionStart = result.entries.find((entry) => entry.name === 'SessionStart');
      expect(sessionStart?.installed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('stops handling config requests after destroy()', async () => {
      await service!.destroy();
      service = undefined;

      await expect(bus.request(CodexClientSubjects.config.hooks.list, {})).rejects.toThrow();
    });
  });
});

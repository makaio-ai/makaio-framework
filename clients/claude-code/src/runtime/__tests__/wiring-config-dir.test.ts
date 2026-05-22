/**
 * Integration tests for config-dir-aware Claude Code wiring.
 *
 * Verifies that {@link applyClaudeCodeWiring} and
 * {@link buildClaudeCodeWiringList} honour the `configDir` path when a
 * {@link ClaudeCodeClientSettings} instance is constructed with one.
 *
 * Unlike the unit tests in `wiring.test.ts` (which use a mock settings object),
 * these tests construct a real {@link ClaudeCodeClientSettings} backed by a
 * temporary filesystem so that the full path-resolution ↔ read/write chain is
 * exercised.
 *
 * The second half of this file tests {@link ClaudeCodeClientService} through
 * the bus: it verifies that the service resolves the config directory via
 * `client.resolveBinary` (using `requestOptional` so that missing handlers are
 * gracefully ignored) and passes it through to wiring and config operations.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { BinaryNotFoundError, ClientSubjects } from '@makaio/subsystem-client';

import { ClaudeCodeClientSettings } from '../client-settings.js';
import { applyClaudeCodeWiring, buildClaudeCodeWiringList } from '../wiring.js';
import { ClaudeCodeClientService } from '../claude-code-client-service.js';
import { ClaudeCodeClientSubjects } from '../namespace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory for a test and return its path.
 * Cleaned up in `afterEach`.
 * @returns Absolute path to the newly created temp directory.
 */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wiring-config-dir-test-'));
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

/**
 * Create a manually controlled promise for ordering cache-invalidation tests.
 * @returns Promise plus resolve/reject controls.
 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAKAIO_CMD = 'makaio';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('applyClaudeCodeWiring with configDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    // Redirect HOME so the default ~/.claude path is safely inside tmpDir and
    // never touched by the default-path code paths exercised in other test files.
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes hooks to configDir/settings.json, not to the default ~/.claude/settings.json', async () => {
    const configDir = path.join(tmpDir, 'isolated');
    const settings = new ClaudeCodeClientSettings({ configDir });

    await applyClaudeCodeWiring(settings, 'user', MAKAIO_CMD);

    const isolatedPath = path.join(configDir, 'settings.json');
    const defaultPath = path.join(tmpDir, 'home', '.claude', 'settings.json');

    // The isolated file must exist and contain hooks.
    const written = await readSettings(isolatedPath);
    expect(written['hooks']).toBeDefined();

    // The default path must not have been created.
    await expect(fs.access(defaultPath)).rejects.toThrow();
  });

  it('writes all session-event hooks and the statusline into the isolated settings file', async () => {
    const configDir = path.join(tmpDir, 'isolated');
    const settings = new ClaudeCodeClientSettings({ configDir });

    const { applied } = await applyClaudeCodeWiring(settings, 'user', MAKAIO_CMD);
    expect(applied).toBeGreaterThan(0);

    const written = await readSettings(path.join(configDir, 'settings.json'));

    // Hooks map must be present
    expect(typeof written['hooks']).toBe('object');

    // Statusline must be present
    const statusLine = written['statusLine'] as { type: string; command: string } | undefined;
    expect(statusLine).toBeDefined();
    expect(statusLine?.type).toBe('command');
    expect(statusLine?.command).toContain('claude statusline');
  });

  it('is idempotent: running apply twice reports all entries skipped on the second call', async () => {
    const configDir = path.join(tmpDir, 'isolated');
    const settings = new ClaudeCodeClientSettings({ configDir });

    await applyClaudeCodeWiring(settings, 'user', MAKAIO_CMD);
    const second = await applyClaudeCodeWiring(settings, 'user', MAKAIO_CMD);

    expect(second.applied).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });
});

describe('buildClaudeCodeWiringList with configDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports all entries as not installed when the isolated configDir has no settings file', async () => {
    const configDir = path.join(tmpDir, 'isolated');
    const settings = new ClaudeCodeClientSettings({ configDir });

    const { entries } = await buildClaudeCodeWiringList(settings, MAKAIO_CMD);
    expect(entries.every((e) => !e.installed)).toBe(true);
  });

  it('reports entries as installed after applyClaudeCodeWiring writes to the isolated path', async () => {
    const configDir = path.join(tmpDir, 'isolated');
    const settings = new ClaudeCodeClientSettings({ configDir });

    await applyClaudeCodeWiring(settings, 'user', MAKAIO_CMD);

    const { entries } = await buildClaudeCodeWiringList(settings, MAKAIO_CMD);
    expect(entries.every((e) => e.installed)).toBe(true);
  });

  it('reads from configDir, not from the default ~/.claude path', async () => {
    const configDir = path.join(tmpDir, 'isolated');
    const defaultClaudeDir = path.join(tmpDir, 'home', '.claude');

    // Pre-populate the default path with hooks to ensure they are not read.
    await fs.mkdir(defaultClaudeDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultClaudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `${MAKAIO_CMD} hook received claude-code SessionStart` }] },
          ],
        },
      }),
      'utf-8',
    );

    // configDir is empty.
    const settings = new ClaudeCodeClientSettings({ configDir });
    const { entries } = await buildClaudeCodeWiringList(settings, MAKAIO_CMD);

    // The default-path hooks must not affect the result.
    expect(entries.every((e) => !e.installed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Service-level integration: resolveBinary → configDir forwarding
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ClientExecutionContext` response for the `resolveBinary`
 * mock handler.
 * @param configDir - Absolute path to use as the config directory, or null.
 * @param source - Resolution source (`'managed'` or `'global'`).
 * @returns Minimal execution context object.
 */
function makeExecutionContext(
  configDir: string | null,
  source: 'managed' | 'global' = 'managed',
): {
  binaryPath: null;
  env: Record<string, string>;
  configDir: string | null;
  source: 'managed' | 'global';
  version: null;
} {
  return { binaryPath: null, env: {}, configDir, source, version: null };
}

describe('ClaudeCodeClientService — wiring handlers use resolveBinary for configDir', () => {
  let bus: IMakaioBus;
  let service: ClaudeCodeClientService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-svc-resolvebinary-test-'));
    // Redirect HOME so the default ~/.claude path never collides with isolated dirs.
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

  it('wiring.apply writes to the isolated configDir when resolveBinary returns a managed context', async () => {
    const configDir = path.join(tmpDir, 'managed-config');
    const projectDir = path.join(tmpDir, 'project');

    // Register a resolveBinary handler that returns the isolated configDir.
    const cleanup = bus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult(makeExecutionContext(configDir, 'managed'));
    });

    const result = await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
      scope: 'user',
      projectDir,
      makaioCommand: MAKAIO_CMD,
    });

    cleanup();

    expect(result.applied).toBeGreaterThan(0);

    // Hooks must be written to the isolated configDir, not to ~/.claude.
    const isolatedSettingsPath = path.join(configDir, 'settings.json');
    const defaultPath = path.join(tmpDir, 'home', '.claude', 'settings.json');

    const written = await fs
      .readFile(isolatedSettingsPath, 'utf-8')
      .then((c) => JSON.parse(c) as Record<string, unknown>);
    expect(written['hooks']).toBeDefined();

    // The default path must not have been created.
    await expect(fs.access(defaultPath)).rejects.toThrow();
  });

  it('wiring.list reads from the isolated configDir when resolveBinary returns a managed context', async () => {
    const configDir = path.join(tmpDir, 'managed-config');
    const projectDir = path.join(tmpDir, 'project');
    const defaultClaudeDir = path.join(tmpDir, 'home', '.claude');

    // Pre-populate the default path with hooks that must NOT be seen.
    await fs.mkdir(defaultClaudeDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultClaudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `${MAKAIO_CMD} hook received claude-code SessionStart` }] },
          ],
        },
      }),
      'utf-8',
    );

    // Register a resolveBinary handler that returns the isolated, empty configDir.
    const cleanup = bus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult(makeExecutionContext(configDir, 'managed'));
    });

    const result = await bus.request(ClaudeCodeClientSubjects.wiring.list, {
      projectDir,
      makaioCommand: MAKAIO_CMD,
    });

    cleanup();

    // The isolated configDir has no settings file, so nothing should be installed.
    expect(result.entries.every((e) => !e.installed)).toBe(true);
  });

  it('wiring.apply writes to ~/.claude when resolveBinary returns the global configDir', async () => {
    const projectDir = path.join(tmpDir, 'project');
    const defaultClaudeDir = path.join(tmpDir, 'home', '.claude');

    // Register a resolveBinary handler matching the real global contract.
    const cleanup = bus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult(makeExecutionContext(defaultClaudeDir, 'global'));
    });

    const result = await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
      scope: 'user',
      projectDir,
      makaioCommand: MAKAIO_CMD,
    });

    cleanup();

    expect(result.applied).toBeGreaterThan(0);

    // Hooks must be written to the default ~/.claude path.
    const defaultSettingsPath = path.join(defaultClaudeDir, 'settings.json');
    const written = await fs
      .readFile(defaultSettingsPath, 'utf-8')
      .then((c) => JSON.parse(c) as Record<string, unknown>);
    expect(written['hooks']).toBeDefined();
  });

  it('wiring.remove removes from the isolated configDir when resolveBinary returns a managed context', async () => {
    const configDir = path.join(tmpDir, 'managed-config');
    const projectDir = path.join(tmpDir, 'project');
    const settings = new ClaudeCodeClientSettings({ projectDir, configDir });
    await applyClaudeCodeWiring(settings, 'user', MAKAIO_CMD);

    const cleanup = bus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult(makeExecutionContext(configDir, 'managed'));
    });

    const result = await bus.request(ClaudeCodeClientSubjects.wiring.remove, {
      scope: 'user',
      projectDir,
    });

    cleanup();

    expect(result.removed).toBeGreaterThan(0);
    const list = await buildClaudeCodeWiringList(settings, MAKAIO_CMD);
    expect(list.entries.every((entry) => !entry.installed)).toBe(true);
  });

  it('wiring.apply falls back to ~/.claude when resolveBinary cannot find a global binary', async () => {
    const projectDir = path.join(tmpDir, 'project');
    const defaultClaudeDir = path.join(tmpDir, 'home', '.claude');

    const cleanup = bus.on(ClientSubjects.resolveBinary, () => {
      throw new BinaryNotFoundError('claude-code');
    });

    const result = await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
      scope: 'user',
      projectDir,
      makaioCommand: MAKAIO_CMD,
    });

    cleanup();

    expect(result.applied).toBeGreaterThan(0);
    const written = await readSettings(path.join(defaultClaudeDir, 'settings.json'));
    expect(written['hooks']).toBeDefined();
  });

  it('wiring.apply writes to ~/.claude when resolveBinary handler is not registered (graceful fallback)', async () => {
    const projectDir = path.join(tmpDir, 'project');
    const defaultClaudeDir = path.join(tmpDir, 'home', '.claude');

    // No resolveBinary handler registered — requestOptional should return { handled: false }.
    const result = await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
      scope: 'user',
      projectDir,
      makaioCommand: MAKAIO_CMD,
    });

    expect(result.applied).toBeGreaterThan(0);

    // Hooks must be written to the default ~/.claude path.
    const defaultSettingsPath = path.join(defaultClaudeDir, 'settings.json');
    const written = await fs
      .readFile(defaultSettingsPath, 'utf-8')
      .then((c) => JSON.parse(c) as Record<string, unknown>);
    expect(written['hooks']).toBeDefined();
  });

  it('re-resolves configDir after an initial missing resolveBinary handler', async () => {
    const projectDir = path.join(tmpDir, 'project');
    const defaultClaudeDir = path.join(tmpDir, 'home', '.claude');
    const isolatedConfigDir = path.join(tmpDir, 'managed-config-after-registration');

    await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
      scope: 'user',
      projectDir,
      makaioCommand: MAKAIO_CMD,
    });

    const cleanup = bus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult(makeExecutionContext(isolatedConfigDir, 'managed'));
    });

    try {
      await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
        scope: 'user',
        projectDir,
        makaioCommand: MAKAIO_CMD,
      });
    } finally {
      cleanup();
    }

    const isolatedSettings = await readSettings(path.join(isolatedConfigDir, 'settings.json'));
    expect(isolatedSettings['hooks']).toBeDefined();

    const defaultSettings = await readSettings(path.join(defaultClaudeDir, 'settings.json'));
    expect(defaultSettings['hooks']).toBeDefined();
  });

  it('re-resolves a concrete cached configDir after client.version.changed', async () => {
    const projectDir = path.join(tmpDir, 'project');
    const firstConfigDir = path.join(tmpDir, 'first-config');
    const secondConfigDir = path.join(tmpDir, 'second-config');
    let currentConfigDir = firstConfigDir;
    let resolveBinaryCalls = 0;

    const cleanup = bus.on(ClientSubjects.resolveBinary, (ctx) => {
      resolveBinaryCalls += 1;
      ctx.setResult(makeExecutionContext(currentConfigDir, 'managed'));
    });

    await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
      scope: 'user',
      projectDir,
      makaioCommand: MAKAIO_CMD,
    });

    currentConfigDir = secondConfigDir;
    await bus.emit(ClientSubjects.version.changed, {
      clientId: 'claude-code',
      previousActiveVersion: '1.0.0',
      activeVersion: '2.0.0',
      reason: 'set-active',
    });

    await bus.request(ClaudeCodeClientSubjects.wiring.apply, {
      scope: 'user',
      projectDir,
      makaioCommand: MAKAIO_CMD,
    });

    cleanup();

    expect(resolveBinaryCalls).toBe(2);
    expect(await readSettings(path.join(firstConfigDir, 'settings.json'))).toHaveProperty('hooks');
    expect(await readSettings(path.join(secondConfigDir, 'settings.json'))).toHaveProperty('hooks');
  });

  it('keeps a newer cached configDir when an older unresolved lookup finishes after version invalidation', async () => {
    const projectDir = path.join(tmpDir, 'project');
    const currentConfigDir = path.join(tmpDir, 'current-config');
    const firstLookup = createDeferred<ReturnType<typeof makeExecutionContext>>();
    let resolveBinaryCalls = 0;

    const cleanup = bus.on(ClientSubjects.resolveBinary, async (ctx) => {
      resolveBinaryCalls += 1;
      if (resolveBinaryCalls === 1) {
        ctx.setResult(await firstLookup.promise);
        return;
      }
      ctx.setResult(makeExecutionContext(currentConfigDir, 'managed'));
    });

    const firstRequest = bus.request(ClaudeCodeClientSubjects.config.hooks.list, { projectDir });

    await vi.waitFor(() => {
      expect(resolveBinaryCalls).toBe(1);
    });

    await bus.emit(ClientSubjects.version.changed, {
      clientId: 'claude-code',
      previousActiveVersion: '1.0.0',
      activeVersion: '2.0.0',
      reason: 'set-active',
    });

    await bus.request(ClaudeCodeClientSubjects.config.hooks.list, { projectDir });
    firstLookup.resolve(makeExecutionContext(null, 'global'));
    await firstRequest;

    await bus.request(ClaudeCodeClientSubjects.config.hooks.list, { projectDir });
    cleanup();

    expect(resolveBinaryCalls).toBe(2);
  });
});

describe('ClaudeCodeClientService — config handlers use resolveBinary for configDir', () => {
  let bus: IMakaioBus;
  let service: ClaudeCodeClientService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-svc-config-resolvebinary-test-'));
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

  it('config.hooks.list reads from the isolated configDir when resolveBinary returns one', async () => {
    const configDir = path.join(tmpDir, 'managed-config');
    const projectDir = path.join(tmpDir, 'project');
    const defaultClaudeDir = path.join(tmpDir, 'home', '.claude');

    // Pre-populate the default path with a hook that must NOT be read.
    await fs.mkdir(defaultClaudeDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultClaudeDir, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo default-hook' }] }] },
      }),
      'utf-8',
    );

    const cleanup = bus.on(ClientSubjects.resolveBinary, (ctx) => {
      ctx.setResult(makeExecutionContext(configDir, 'managed'));
    });

    const result = await bus.request(ClaudeCodeClientSubjects.config.hooks.list, { projectDir });

    cleanup();

    // The isolated configDir has no settings file, so hooks should be empty.
    expect(result.effective).toEqual({});
  });

  it('config.hooks.list falls back to ~/.claude when resolveBinary is not registered', async () => {
    const projectDir = path.join(tmpDir, 'project');
    const defaultClaudeDir = path.join(tmpDir, 'home', '.claude');

    // Pre-populate the default path with a hook.
    await fs.mkdir(defaultClaudeDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultClaudeDir, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo default-hook' }] }] },
      }),
      'utf-8',
    );

    // No resolveBinary handler registered — should fall back to ~/.claude.
    const result = await bus.request(ClaudeCodeClientSubjects.config.hooks.list, { projectDir });

    expect(result.effective['PreToolUse']).toBeDefined();
    expect(result.effective['PreToolUse']).toHaveLength(1);
  });
});

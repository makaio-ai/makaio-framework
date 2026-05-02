/**
 * Tests for {@link ClientBinaryManager} `client.resolveBinary` handler.
 *
 * Uses a real bus instance with real Drizzle storage handlers registered
 * against an in-memory SQLite database. The handler is tested end-to-end
 * through the bus contract.
 *
 * Coverage:
 * - managed resolution: active managed version → returns binaryPath, env,
 *   configDir, source:'managed', version
 * - global fallback: no active managed version → falls back to scan → returns
 *   binaryPath:null, empty env, configDir from defaultPath, source:'global'
 * - no configIsolation: managed binary without configIsolation → empty env,
 *   null configDir
 * - not found: scan returns found:false → throws
 * - unknown clientId: no definition registered → throws
 * - managed active but no versionCommand → throws
 * - global fallback but no binaryName → throws
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, RequestError, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, createClientDefinition, type ClientDefinition } from '@makaio/contracts/client';
import { createPluginTestDb, type PluginTestDbContext } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { BinaryNotFoundError } from '../client-binary-errors.js';
import { registerDrizzleClientBinaryStorage } from '../storage/client-binary-drizzle-handler.js';
import { ClientBinaryManager } from '../client-binary-manager.js';
import { ClientBinaryStorageSubjects } from '../storage/client-binary-storage-namespace.js';
import type { ClientDefinitionLookup } from '../client-binary-manager-types.js';
import type { StrategyDependencies } from '../binary-strategies/index.js';
import { createNoopStrategyDeps } from '../client-binary-noop-strategy-deps.js';
import { CLIENT_BINARY_DDL } from './test-ddl.js';

// ---------------------------------------------------------------------------
// Shared test client definitions
// ---------------------------------------------------------------------------

const BASE_DEFINITION_INPUT = {
  id: 'claude-code',
  name: 'Claude Code',
  defaultApprovalPolicy: 'always-ask' as const,
  binaryName: 'claude',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: {
    type: 'npm' as const,
    package: '@anthropic-ai/claude-code',
  },
  versionCommand: ['bin/claude', '--version'],
  configIsolation: {
    envVar: 'CLAUDE_CONFIG_DIR',
    defaultPath: '~/.claude',
  },
};

const DEFINITION_WITH_ISOLATION = createClientDefinition(BASE_DEFINITION_INPUT);

const DEFINITION_NO_ISOLATION = createClientDefinition({
  ...BASE_DEFINITION_INPUT,
  id: 'claude-code-no-iso',
  configIsolation: undefined,
});

/**
 * A global-only definition (no managedInstall, no versionCommand) that declares
 * a binaryName for PATH scanning. Used to seed storage with an "orphan" active
 * version to trigger the missing-versionCommand guard in buildManagedContext.
 */
const DEFINITION_NO_VERSION_COMMAND = createClientDefinition({
  id: 'global-only',
  name: 'Global Only',
  defaultApprovalPolicy: 'always-ask' as const,
  binaryName: 'global-only',
  runtimeCapabilities: {},
});

/**
 * A definition with no binaryName to trigger the missing-binaryName guard in
 * buildGlobalContext when no managed version is active.
 */
const DEFINITION_NO_BINARY_NAME = createClientDefinition({
  id: 'no-binary-name',
  name: 'No Binary Name',
  defaultApprovalPolicy: 'always-ask' as const,
  runtimeCapabilities: {},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinitionLookup(definitions: ReturnType<typeof createClientDefinition>[]): ClientDefinitionLookup {
  return {
    getDefinition: (clientId) => definitions.find((d) => d.id === clientId),
    listDefinitions: () => definitions,
  };
}

function makeNoopDeps(): StrategyDependencies {
  return createNoopStrategyDeps();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ClientBinaryManager — client.resolveBinary', () => {
  let bus: IMakaioBus;
  let manager: ClientBinaryManager;
  let storageCleanup: () => void;
  let dbCtx: PluginTestDbContext;
  let testBasePath: string;
  let testConfigBasePath: string;

  beforeAll(async () => {
    dbCtx = await createPluginTestDb({
      name: 'client-binary-resolve',
      schemas: CLIENT_BINARY_DDL,
      tables: ['client_binary_versions', 'client_binary_state'],
      registerHandlers: () => () => {},
    });
  });

  afterAll(async () => {
    await dbCtx.close();
  });

  beforeEach(async () => {
    await dbCtx.clearData();
    testBasePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'makaio-resolve-test-'));
    testConfigBasePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'makaio-config-test-'));
    bus = createBusInstance();
    storageCleanup = registerDrizzleClientBinaryStorage(bus, dbCtx.db, makeStubExtensionContext(bus));
  });

  afterEach(async () => {
    await manager?.destroy();
    storageCleanup();
    await fsp.rm(testBasePath, { recursive: true, force: true });
    await fsp.rm(testConfigBasePath, { recursive: true, force: true });
  });

  async function initManager(definitions: ReturnType<typeof createClientDefinition>[]): Promise<void> {
    manager = new ClientBinaryManager(
      bus,
      { basePath: testBasePath, configBasePath: testConfigBasePath },
      makeDefinitionLookup(definitions),
      makeNoopDeps(),
    );
    await manager.init();
  }

  async function seedActiveVersion(clientId: string, version: string, installPath: string): Promise<void> {
    const now = Date.now();
    await fsp.mkdir(installPath, { recursive: true });
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId,
      version,
      installPath,
      installedAt: now,
      createdAt: now,
    });
    await bus.request(ClientBinaryStorageSubjects.setActiveVersion, {
      clientId,
      activeVersion: version,
      updatedAt: now,
    });
  }

  async function setActivePointer(clientId: string, version: string): Promise<void> {
    await bus.request(ClientBinaryStorageSubjects.setActiveVersion, {
      clientId,
      activeVersion: version,
      updatedAt: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Managed resolution
  // -------------------------------------------------------------------------

  it('returns managed context when an active version exists', async () => {
    await initManager([DEFINITION_WITH_ISOLATION]);

    const version = '1.2.3';
    const installPath = path.join(testBasePath, 'claude-code', version);
    await seedActiveVersion('claude-code', version, installPath);

    const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code' });

    const expectedBinaryPath = path.join(installPath, 'bin', 'claude');
    const expectedConfigDir = path.join(testConfigBasePath, 'claude-code', 'config');

    expect(result.source).toBe('managed');
    expect(result.version).toBe(version);
    expect(result.binaryPath).toBe(expectedBinaryPath);
    expect(result.configDir).toBe(expectedConfigDir);
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: expectedConfigDir });
  });

  it('uses the stored installPath for the active version record', async () => {
    await initManager([DEFINITION_WITH_ISOLATION]);

    const version = '1.2.3';
    const installPath = path.join(testBasePath, 'claude-code', version, 'artifact-root');
    await seedActiveVersion('claude-code', version, installPath);

    const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code' });

    expect(result.binaryPath).toBe(path.join(installPath, 'bin', 'claude'));
  });

  it('rejects an active version record whose installPath points at a different version', async () => {
    await initManager([DEFINITION_WITH_ISOLATION]);

    const activeVersion = '1.2.3';
    const otherVersionPath = path.join(testBasePath, 'claude-code', '2.0.0');
    await seedActiveVersion('claude-code', activeVersion, otherVersionPath);

    await expect(bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code' })).rejects.toThrow(
      `stored installPath "${otherVersionPath}" does not match the expected install directory for claude-code@${activeVersion}`,
    );
  });

  it('returns managed context with null configDir when no configIsolation on definition', async () => {
    await initManager([DEFINITION_NO_ISOLATION]);

    const version = '1.0.0';
    const installPath = path.join(testBasePath, 'claude-code-no-iso', version);
    await seedActiveVersion('claude-code-no-iso', version, installPath);

    const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code-no-iso' });

    const expectedBinaryPath = path.join(installPath, 'bin', 'claude');

    expect(result.source).toBe('managed');
    expect(result.version).toBe(version);
    expect(result.binaryPath).toBe(expectedBinaryPath);
    expect(result.configDir).toBeNull();
    expect(result.env).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Global fallback
  // -------------------------------------------------------------------------

  it('falls back to global scan when no active managed version exists', async () => {
    await initManager([DEFINITION_WITH_ISOLATION]);

    // Register a mock scan handler that simulates finding the binary globally
    const scanCleanup = bus.on(
      ClientSubjects.scan,
      (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'claude-code', found: true, version: '1.9.0' }],
        });
      },
      { priority: 100 },
    );

    try {
      const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code' });

      const expectedConfigDir = path.join(os.homedir(), '.claude');

      expect(result.source).toBe('global');
      expect(result.binaryPath).toBeNull();
      expect(result.version).toBe('1.9.0');
      expect(result.configDir).toBe(expectedConfigDir);
      expect(result.env).toEqual({});
    } finally {
      scanCleanup();
    }
  });

  it('global fallback: version is null when scan returns no version', async () => {
    await initManager([DEFINITION_WITH_ISOLATION]);

    const scanCleanup = bus.on(
      ClientSubjects.scan,
      (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'claude-code', found: true }],
        });
      },
      { priority: 100 },
    );

    try {
      const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code' });

      expect(result.source).toBe('global');
      expect(result.binaryPath).toBeNull();
      expect(result.version).toBeNull();
    } finally {
      scanCleanup();
    }
  });

  it('global fallback: configDir is null when no configIsolation is declared', async () => {
    await initManager([DEFINITION_NO_ISOLATION]);

    const scanCleanup = bus.on(
      ClientSubjects.scan,
      (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'claude-code-no-iso', found: true, version: '2.0.0' }],
        });
      },
      { priority: 100 },
    );

    try {
      const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code-no-iso' });

      expect(result.source).toBe('global');
      expect(result.configDir).toBeNull();
    } finally {
      scanCleanup();
    }
  });

  it('global fallback: expands a standalone tilde default path to the home directory', async () => {
    const definition = createClientDefinition({
      ...BASE_DEFINITION_INPUT,
      id: 'home-only',
      binaryName: 'home-only',
      configIsolation: { envVar: 'HOME_ONLY_CONFIG', defaultPath: '~' },
    });
    await initManager([definition]);

    const scanCleanup = bus.on(
      ClientSubjects.scan,
      (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'home-only', found: true }],
        });
      },
      { priority: 100 },
    );

    try {
      const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'home-only' });

      expect(result.configDir).toBe(os.homedir());
    } finally {
      scanCleanup();
    }
  });

  it('global fallback: returns the containing directory for file-target defaults', async () => {
    const definition = createClientDefinition({
      ...BASE_DEFINITION_INPUT,
      id: 'qwen',
      binaryName: 'qwen',
      configIsolation: {
        envVar: 'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
        defaultPath: '/etc/qwen-code/system-defaults.json',
        pathKind: 'file',
      },
    });
    await initManager([definition]);

    const scanCleanup = bus.on(
      ClientSubjects.scan,
      (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'qwen', found: true }],
        });
      },
      { priority: 100 },
    );

    try {
      const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'qwen' });

      expect(result.configDir).toBe('/etc/qwen-code');
    } finally {
      scanCleanup();
    }
  });

  it('managed resolution: file-target configIsolation sets env to a file inside the isolated config dir', async () => {
    const definition = createClientDefinition({
      ...BASE_DEFINITION_INPUT,
      id: 'qwen',
      binaryName: 'qwen',
      configIsolation: {
        envVar: 'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
        defaultPath: '/etc/qwen-code/system-defaults.json',
        pathKind: 'file',
      },
    });
    await initManager([definition]);

    const version = '1.0.0';
    const installPath = path.join(testBasePath, 'qwen', version);
    await seedActiveVersion('qwen', version, installPath);

    const result = await bus.request(ClientSubjects.resolveBinary, { clientId: 'qwen' });

    const expectedConfigDir = path.join(testConfigBasePath, 'qwen', 'config');
    expect(result.configDir).toBe(expectedConfigDir);
    expect(result.env).toEqual({
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(expectedConfigDir, 'system-defaults.json'),
    });
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------

  it('throws when global scan returns found:false', async () => {
    await initManager([DEFINITION_WITH_ISOLATION]);

    const scanCleanup = bus.on(
      ClientSubjects.scan,
      (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'claude-code', found: false }],
        });
      },
      { priority: 100 },
    );

    try {
      const error = await bus
        .request(ClientSubjects.resolveBinary, { clientId: 'claude-code' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).cause).toBeInstanceOf(BinaryNotFoundError);
      expect(((error as RequestError).cause as BinaryNotFoundError).code).toBe('BINARY_NOT_FOUND');
    } finally {
      scanCleanup();
    }
  });

  it('throws when global scan returns no result entry for the client', async () => {
    await initManager([DEFINITION_WITH_ISOLATION]);

    const scanCleanup = bus.on(
      ClientSubjects.scan,
      (ctx) => {
        ctx.setResult({ results: [] });
      },
      { priority: 100 },
    );

    try {
      await expect(bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code' })).rejects.toThrow(
        "'claude-code'",
      );
    } finally {
      scanCleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Unknown clientId
  // -------------------------------------------------------------------------

  it('throws when no definition is registered for the clientId', async () => {
    await initManager([]);

    await expect(bus.request(ClientSubjects.resolveBinary, { clientId: 'no-such-client' })).rejects.toThrow(
      "no definition registered for client 'no-such-client'",
    );
  });

  it('throws when the active version pointer has no installed version record', async () => {
    await initManager([DEFINITION_WITH_ISOLATION]);

    await setActivePointer('claude-code', 'missing-version');

    await expect(bus.request(ClientSubjects.resolveBinary, { clientId: 'claude-code' })).rejects.toThrow(
      `active version 'missing-version' is not installed`,
    );
  });

  // -------------------------------------------------------------------------
  // Guard: versionCommand absent on managed context
  // -------------------------------------------------------------------------

  it('throws when definition has no versionCommand but storage has an active managed version', async () => {
    // DEFINITION_NO_VERSION_COMMAND has no managedInstall/versionCommand.
    // We seed storage directly to simulate an "orphan" active version (e.g.
    // the definition was downgraded after the binary was installed).
    await initManager([DEFINITION_NO_VERSION_COMMAND]);

    const version = '0.1.0';
    const installPath = path.join(testBasePath, 'global-only', version);
    await seedActiveVersion('global-only', version, installPath);

    await expect(bus.request(ClientSubjects.resolveBinary, { clientId: 'global-only' })).rejects.toThrow(
      `definition for 'global-only' has no versionCommand`,
    );
  });

  // -------------------------------------------------------------------------
  // Guard: binaryName absent on global fallback
  // -------------------------------------------------------------------------

  it('throws when definition has no binaryName and no managed version is active', async () => {
    await initManager([DEFINITION_NO_BINARY_NAME]);

    // No active managed version seeded → buildGlobalContext will be reached
    await expect(bus.request(ClientSubjects.resolveBinary, { clientId: 'no-binary-name' })).rejects.toThrow(
      `definition for 'no-binary-name' has no binaryName`,
    );
  });

  // -------------------------------------------------------------------------
  // Guard: versionCommand directory traversal
  // -------------------------------------------------------------------------

  it('throws when versionCommand[0] resolves outside the install directory', async () => {
    // The schema rejects `..` segments at parse time, so this test injects a
    // tampered definition object directly — simulating a definition that bypasses
    // schema validation (e.g. loaded from a corrupted or malicious source).
    // The runtime guard in buildManagedContext is the last line of defense.
    const tamperedDefinition: ClientDefinition = {
      ...DEFINITION_WITH_ISOLATION,
      id: 'traversal-test',
      binaryName: 'traversal-test',
      versionCommand: ['../../etc/evil', '--version'],
    };
    await initManager([tamperedDefinition]);

    const version = '1.0.0';
    const installPath = path.join(testBasePath, 'traversal-test', version);
    await seedActiveVersion('traversal-test', version, installPath);

    await expect(bus.request(ClientSubjects.resolveBinary, { clientId: 'traversal-test' })).rejects.toThrow(
      `versionCommand for 'traversal-test' resolves outside the install directory`,
    );
  });

  // -------------------------------------------------------------------------
  // Guard: relative defaultPath in configIsolation
  // -------------------------------------------------------------------------

  it('rejects a definition with a relative configIsolation.defaultPath at schema parse time', () => {
    // ConfigIsolationSchema enforces that defaultPath must be absolute, '~', or
    // start with `~/`, so relative paths are caught before the runtime guard.
    expect(() =>
      createClientDefinition({
        ...BASE_DEFINITION_INPUT,
        id: 'bad-path-client',
        binaryName: 'bad-path-client',
        configIsolation: { envVar: 'BAD_PATH_CONFIG', defaultPath: 'relative/config' },
      }),
    ).toThrow("defaultPath must be absolute, '~', or start with '~/'");
  });

  it('rejects a definition with a relative configIsolation.defaultPath (file pathKind) at schema parse time', () => {
    // For file-kind paths the same schema-level constraint applies.
    expect(() =>
      createClientDefinition({
        ...BASE_DEFINITION_INPUT,
        id: 'bad-file-path-client',
        binaryName: 'bad-file-path-client',
        configIsolation: {
          envVar: 'BAD_FILE_PATH_CONFIG',
          defaultPath: 'relative/config/settings.json',
          pathKind: 'file',
        },
      }),
    ).toThrow("defaultPath must be absolute, '~', or start with '~/'");
  });

  // Note (F3 false positive): Vitest's `.toThrow(string)` does substring matching, so
  // passing a partial error message such as `'configBasePath requires a non-empty absolute basePath'`
  // correctly matches the full thrown message. This is intentional — the substring is
  // the discriminating part of the error; asserting the full message would couple the
  // test to incidental wording that may change.
  it('throws when configBasePath is relative', () => {
    expect(
      () =>
        new ClientBinaryManager(
          bus,
          { basePath: testBasePath, configBasePath: 'relative-config' },
          makeDefinitionLookup([DEFINITION_WITH_ISOLATION]),
          makeNoopDeps(),
        ),
    ).toThrow('configBasePath requires a non-empty absolute basePath');
  });
});

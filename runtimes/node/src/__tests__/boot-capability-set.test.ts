/**
 * Tests for host-declared runtime environment construction in the boot sequence.
 *
 * These tests cover the pure {@link buildRuntimeEnvironment} helper, which is
 * the only extractable unit of the capability logic inside `bootMakaioRuntime`.
 * Full integration tests (requiring an HTTP server, SQLite, etc.) are out of
 * scope here.
 *
 * A second describe block exercises the full path from {@link buildRuntimeEnvironment}
 * through {@link ExtensionCoordinator} to verify that requirement-gated packages
 * are correctly included or excluded based on the host's declared environment.
 */

import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { MakaioExtension } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import { frameworkCorePackages, SessionOrchestratorToken } from '@makaio/services-core';
import {
  buildRuntimeEnvironment,
  mergePackageConfigDefaults,
  normalizeNodeHostCapabilities,
  selectFrameworkCorePackages,
} from '../boot.js';
import { isMissingOptionalRuntimePackage } from '../optional-package.js';

describe('buildRuntimeEnvironment', () => {
  it('always includes the given platform in hosts', () => {
    const env = buildRuntimeEnvironment('linux');

    expect(env.hosts.has('linux')).toBe(true);
  });

  it('does not inject node into hosts automatically when hostCapabilities is omitted', () => {
    const env = buildRuntimeEnvironment('darwin');

    expect(env.hosts.has('node')).toBe(false);
    expect([...env.hosts]).toStrictEqual(['darwin']);
  });

  it('produces only platform in hosts when hostCapabilities is an empty array', () => {
    const env = buildRuntimeEnvironment('win32', []);

    expect([...env.hosts]).toStrictEqual(['win32']);
    expect(env.capabilities.size).toBe(0);
  });

  it('places string tokens in hosts only and object tokens in capabilities only', () => {
    const env = buildRuntimeEnvironment('darwin', ['node', 'native-pty', 'workspace-host']);

    expect(env.hosts.has('darwin')).toBe(true);
    expect(env.hosts.has('node')).toBe(true);
    expect(env.hosts.has('native-pty')).toBe(true);
    expect(env.hosts.has('workspace-host')).toBe(true);
    expect(env.capabilities.size).toBe(0);
  });

  it('preserves versions for object-form capability declarations', () => {
    const env = buildRuntimeEnvironment('darwin', [
      'node',
      { id: 'storage.drizzle', version: '1.2.0' },
      { id: 'native-pty' },
    ]);

    expect(env.capabilities.has('storage.drizzle')).toBe(true);
    expect(env.capabilities.has('native-pty')).toBe(true);
    expect(env.capabilityVersions?.get('storage.drizzle')).toBe('1.2.0');
    expect(env.capabilityVersions?.has('native-pty')).toBe(false);
    expect(env.hosts.has('node')).toBe(true);
    expect(env.hosts.has('storage.drizzle')).toBe(false);
  });

  it('host-declared capability token is absent from capabilities when host does not declare it', () => {
    const env = buildRuntimeEnvironment('darwin');

    expect(env.capabilities.has('workspace-host')).toBe(false);
    expect(env.capabilities.has('native-pty')).toBe(false);
    expect(env.capabilities.has('node')).toBe(false);
  });
});

describe('normalizeNodeHostCapabilities', () => {
  it('adds node for Node composition roots without mutating caller tokens', () => {
    const hostCapabilities = ['workspace-host', 'native-pty'] as const;

    expect(normalizeNodeHostCapabilities(hostCapabilities)).toEqual(['node', 'workspace-host', 'native-pty']);
    expect(hostCapabilities).toEqual(['workspace-host', 'native-pty']);
  });

  it('does not duplicate node when the host already declared it', () => {
    const hostCapabilities = ['node', 'native-pty'] as const;

    expect(normalizeNodeHostCapabilities(hostCapabilities)).toBe(hostCapabilities);
  });

  it('adds node when object-form metadata declares a node capability but not a host identity', () => {
    const hostCapabilities = [{ id: 'node', version: '24.0.0' }, 'native-pty'] as const;

    expect(normalizeNodeHostCapabilities(hostCapabilities)).toEqual(['node', ...hostCapabilities]);
  });
});

describe('selectFrameworkCorePackages', () => {
  it('keeps the framework session orchestrator for framework-only hosts', () => {
    expect(selectFrameworkCorePackages([])).toBe(frameworkCorePackages);
    expect(selectFrameworkCorePackages([]).map((pkg) => pkg.name)).toContain(SessionOrchestratorToken.name);
  });

  it('removes only the framework session orchestrator when an extension owns orchestration', () => {
    const selected = selectFrameworkCorePackages([
      {
        name: 'host-runtime',
        displayName: 'Host Runtime',
        version: '0.1.0',
        runtimeOwnership: { sessionOrchestrator: true },
      },
    ]);
    const selectedNames = selected.map((pkg) => pkg.name);

    expect(selectedNames).not.toContain(SessionOrchestratorToken.name);
    expect(selected).toHaveLength(frameworkCorePackages.length - 1);
    expect(selectedNames).toStrictEqual(
      frameworkCorePackages.map((pkg) => pkg.name).filter((name) => name !== SessionOrchestratorToken.name),
    );
  });
});

describe('mergePackageConfigDefaults', () => {
  it('merges host package defaults without dropping descriptor defaults', () => {
    const merged = mergePackageConfigDefaults(
      new Map([['account-manager', { pollIntervalMs: 5_000 }]]),
      new Map([['account-manager', { pollIntervalMs: 10_000, makaioCommand: 'host-cli' }]]),
    );

    expect(merged.get('account-manager')).toStrictEqual({
      pollIntervalMs: 10_000,
      makaioCommand: 'host-cli',
    });
  });
});

describe('buildRuntimeEnvironment → ExtensionCoordinator integration', () => {
  /**
   * Minimal package descriptor that gates on the `node` capability token.
   *
   * No `create` factory is needed: the coordinator marks service-free packages
   * as `active` after `startAll`, so the test only needs to observe whether the
   * package appears in {@link ExtensionCoordinator.list}.
   */
  const nodeGatedPackage: MakaioExtension = {
    name: 'node-feature',
    displayName: 'Node Feature',
    version: '0.1.0',
    requires: [{ type: 'host', id: 'node' }],
  };

  it('includes a requires-gated package when the capability is present', async () => {
    const runtimeEnvironment = buildRuntimeEnvironment('linux', ['node']);
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { runtimeEnvironment });

    try {
      coordinator.load([nodeGatedPackage]);
      await coordinator.startAll();

      const names = coordinator.list().map((e) => e.name);
      expect(names).toContain('node-feature');
      expect(coordinator.list().find((e) => e.name === 'node-feature')?.state).toBe('active');
    } finally {
      await coordinator.shutdown();
    }
  });

  it('excludes a requires-gated package when the capability is absent', async () => {
    const runtimeEnvironment = buildRuntimeEnvironment('linux');
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { runtimeEnvironment });

    try {
      coordinator.load([nodeGatedPackage]);
      await coordinator.startAll();

      const names = coordinator.list().map((e) => e.name);
      expect(names).not.toContain('node-feature');
    } finally {
      await coordinator.shutdown();
    }
  });

  it('includes a package gated on host identity when the host is present', async () => {
    const runtimeEnvironment = buildRuntimeEnvironment('linux', ['node']);
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { runtimeEnvironment });
    const linuxOnlyPackage: MakaioExtension = {
      name: 'linux-feature',
      displayName: 'Linux Feature',
      version: '0.1.0',
      requires: [{ type: 'host', id: 'linux' }],
    };

    try {
      coordinator.load([linuxOnlyPackage]);
      await coordinator.startAll();

      expect(coordinator.list().find((e) => e.name === 'linux-feature')?.state).toBe('active');
    } finally {
      await coordinator.shutdown();
    }
  });

  it('includes a package gated on the node host identity when normalized host capabilities include node', async () => {
    const runtimeEnvironment = buildRuntimeEnvironment('linux', normalizeNodeHostCapabilities());
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { runtimeEnvironment });
    const nodeHostPackage: MakaioExtension = {
      name: 'node-host-feature',
      displayName: 'Linux Feature',
      version: '0.1.0',
      requires: [{ type: 'host', id: 'node' }],
    };

    try {
      coordinator.load([nodeHostPackage]);
      await coordinator.startAll();

      expect(coordinator.list().find((e) => e.name === 'node-host-feature')?.state).toBe('active');
    } finally {
      await coordinator.shutdown();
    }
  });

  it('excludes a package gated on host identity when running on a different host', async () => {
    const runtimeEnvironment = buildRuntimeEnvironment('darwin', ['node']);
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { runtimeEnvironment });
    const linuxOnlyPackage: MakaioExtension = {
      name: 'linux-feature',
      displayName: 'Linux Feature',
      version: '0.1.0',
      requires: [{ type: 'host', id: 'linux' }],
    };

    try {
      coordinator.load([linuxOnlyPackage]);
      await coordinator.startAll();

      expect(coordinator.list()).toHaveLength(0);
    } finally {
      await coordinator.shutdown();
    }
  });
});

describe('isMissingOptionalRuntimePackage', () => {
  it('returns true when the named package is missing', () => {
    const error = new Error("Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /tmp/test.mjs");

    expect(isMissingOptionalRuntimePackage(error, '@anthropic-ai/claude-agent-sdk')).toBe(true);
  });

  it('returns false for module evaluation failures inside the optional package', () => {
    const error = new Error('Unexpected token in @anthropic-ai/claude-agent-sdk');
    (error as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';

    expect(isMissingOptionalRuntimePackage(error, '@anthropic-ai/claude-agent-sdk')).toBe(false);
  });

  it('returns false when a transitive dependency is missing instead of the requested package', () => {
    const error = new Error("Cannot find package 'open' imported from /tmp/claude-agent-sdk/index.mjs");
    (error as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';

    expect(isMissingOptionalRuntimePackage(error, '@anthropic-ai/claude-agent-sdk')).toBe(false);
  });

  it('returns true when an optional runtime subpath is not exported by the requested package', () => {
    const error = new Error(
      `Package subpath './runtime' is not defined by "exports" in /tmp/node_modules/@makaio/client-qwen/package.json imported from /tmp/test.mjs`,
    );
    (error as NodeJS.ErrnoException).code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';

    expect(isMissingOptionalRuntimePackage(error, '@makaio/client-qwen/runtime')).toBe(true);
  });

  it('returns true when an optional runtime subpath import reports the root package as missing', () => {
    const error = new Error("Cannot find package '@makaio/client-qwen' imported from /tmp/test.mjs");
    (error as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';

    expect(isMissingOptionalRuntimePackage(error, '@makaio/client-qwen/runtime')).toBe(true);
  });

  it('does not treat another package with the same basename as the requested optional runtime package', () => {
    const error = new Error(
      `Package subpath './runtime' is not defined by "exports" in /tmp/node_modules/@other/client-qwen/package.json imported from /tmp/test.mjs`,
    );
    (error as NodeJS.ErrnoException).code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';

    expect(isMissingOptionalRuntimePackage(error, '@makaio/client-qwen/runtime')).toBe(false);
  });
});

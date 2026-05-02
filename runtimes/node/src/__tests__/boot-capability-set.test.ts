/**
 * Tests for host-declared capability set construction in the boot sequence.
 *
 * These tests cover the pure {@link buildCapabilitySet} helper, which is the
 * only extractable unit of the capability logic inside `bootMakaioRuntime`.
 * Full integration tests (requiring an HTTP server, SQLite, etc.) are out of
 * scope here.
 *
 * A second describe block exercises the full path from {@link buildCapabilitySet}
 * through {@link ExtensionCoordinator} to verify that capability-gated packages
 * are correctly included or excluded based on the host's declared capabilities.
 */

import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { MakaioExtension } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import { frameworkCorePackages, SessionOrchestratorToken } from '@makaio/services-core';
import {
  buildCapabilitySet,
  mergePackageConfigDefaults,
  normalizeNodeHostCapabilities,
  selectFrameworkCorePackages,
} from '../boot.js';
import { isMissingOptionalRuntimePackage } from '../optional-package.js';

describe('buildCapabilitySet', () => {
  it('always includes the given platform', () => {
    const set = buildCapabilitySet('linux');

    expect(set.has('linux')).toBe(true);
  });

  it('does not inject node automatically when hostCapabilities is omitted', () => {
    const set = buildCapabilitySet('darwin');

    expect(set.has('node')).toBe(false);
    expect([...set]).toStrictEqual(['darwin']);
  });

  it('produces only platform when hostCapabilities is an empty array', () => {
    const set = buildCapabilitySet('win32', []);

    expect([...set]).toStrictEqual(['win32']);
  });

  it('merges host-declared capabilities into the base set', () => {
    const set = buildCapabilitySet('darwin', ['node', 'native-pty', 'workspace-host']);

    expect(set.has('node')).toBe(true);
    expect(set.has('darwin')).toBe(true);
    expect(set.has('native-pty')).toBe(true);
    expect(set.has('workspace-host')).toBe(true);
    expect(set.size).toBe(4);
  });

  it('deduplicates tokens when hostCapabilities overlaps with base tokens', () => {
    const set = buildCapabilitySet('linux', ['node', 'linux', 'native-pty']);

    // Set semantics: duplicates are silently collapsed
    expect(set.has('node')).toBe(true);
    expect(set.has('linux')).toBe(true);
    expect(set.has('native-pty')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('host-declared capability token is absent when host does not declare it', () => {
    const set = buildCapabilitySet('darwin');

    expect(set.has('workspace-host')).toBe(false);
    expect(set.has('native-pty')).toBe(false);
    expect(set.has('node')).toBe(false);
  });

  it('returns a mutable Set (for coordinator consumption)', () => {
    const set = buildCapabilitySet('darwin', ['node', 'workspace-host']);

    // Verify the return type is a real Set that can be mutated
    set.add('extra-token');
    expect(set.has('extra-token')).toBe(true);
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

describe('buildCapabilitySet → ExtensionCoordinator integration', () => {
  /**
   * Minimal package descriptor that gates on the `node` environment token.
   *
   * No `create` factory is needed: the coordinator marks service-free packages
   * as `active` after `startAll`, so the test only needs to observe whether the
   * package appears in {@link ExtensionCoordinator.list}.
   */
  const nodeGatedPackage: MakaioExtension = {
    name: 'node-feature',
    displayName: 'Node Feature',
    requires: ['node'],
  };

  it('includes a requires-gated package when the capability is present', async () => {
    const capabilities = buildCapabilitySet('linux', ['node']);
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { capabilities });

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
    const capabilities = buildCapabilitySet('linux');
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { capabilities });

    try {
      coordinator.load([nodeGatedPackage]);
      await coordinator.startAll();

      const names = coordinator.list().map((e) => e.name);
      expect(names).not.toContain('node-feature');
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

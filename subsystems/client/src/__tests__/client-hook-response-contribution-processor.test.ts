/**
 * Tests for the client hook response contribution processor.
 *
 * Covers activation with valid and invalid contributors, deactivation
 * cleanup, disable-then-re-enable without duplication, shutdown,
 * rollback on factory failure, and silent no-op for extensions that do
 * not declare `clientHookResponses`.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ContributorActivationContext,
  ContributorDefinition,
  ProviderContractCatalogEntry,
} from '@makaio/contracts/client';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { createBusInstance } from '@makaio/bus-core';
import { ClientHookProviderContractRegistry } from '../client-hook-provider-contract-registry.js';
import { ClientHookResponseRegistry } from '../client-hook-response-registry.js';
import { createClientHookResponseContributionProcessor } from '../client-hook-response-contribution-processor.js';

type CanonicalContributorDefinition = Extract<ContributorDefinition, { lane: 'canonical' }>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link ProviderContractCatalogEntry} for test registration.
 * @param overrides - Optional property overrides.
 * @returns A complete catalog entry suitable for the contract registry.
 */
function makeCatalog(overrides: Partial<ProviderContractCatalogEntry> = {}): ProviderContractCatalogEntry {
  return {
    clientId: 'claude-code',
    contractId: 'anthropic.tool-response',
    version: '1.0.0',
    supportedInteractions: ['PreToolUse', 'PostToolUse'],
    blockability: [
      { interaction: 'PreToolUse', blockable: true },
      { interaction: 'PostToolUse', blockable: false },
    ],
    validate: () => true,
    ...overrides,
  };
}

/**
 * Build a valid {@link ContributorDefinition} that selects by event name.
 * @param id - Contributor identifier within the extension.
 * @param overrides - Optional property overrides.
 * @returns A fully typed contributor definition.
 */
function makeContributor(
  id: string,
  overrides: Partial<CanonicalContributorDefinition> = {},
): CanonicalContributorDefinition {
  return {
    lane: 'canonical',
    id,
    priority: 100,
    timeoutMs: 5000,
    selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
    respond: () => undefined,
    ...overrides,
  };
}

/**
 * Build a minimal {@link KernelExtensionContext} stub.
 * @returns Context stub satisfying the contribution processor's needs.
 */
function makeContext(): KernelExtensionContext {
  const bus = createBusInstance();
  return {
    bus,
    identity: {
      extensionName: 'test-ext',
    } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/test-ext',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: () => undefined,
    hasExtension: () => false,
  };
}

/**
 * Build a minimal extension manifest with `clientHookResponses`.
 * @param name - Extension name.
 * @param contributors - Contributors returned by `createContributors`.
 * @returns A fully typed extension manifest.
 */
function makeExtension(name: string, contributors: ContributorDefinition[]): KernelMakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    clientHookResponses: {
      createContributors: () => contributors,
    },
  };
}

/**
 * Build a minimal extension manifest WITHOUT `clientHookResponses`.
 * @param name - Extension name.
 * @returns A fully typed extension manifest with no hook response surface.
 */
function makeExtensionWithout(name: string): KernelMakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createClientHookResponseContributionProcessor', () => {
  it('installs valid contributors on activation', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkg = makeExtension('ext-a', [makeContributor('append-ctx'), makeContributor('log-hook')]);

    await processor.processActivated('ext-a', pkg, makeContext());

    const snapshot = responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((s) => s.namespacedId)).toEqual(['ext-a/append-ctx', 'ext-a/log-hook']);
  });

  it('throws on activation when contributor validation fails', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkg = makeExtension('ext-bad', [
      makeContributor(''), // invalid: empty ID
    ]);

    await expect(processor.processActivated('ext-bad', pkg, makeContext())).rejects.toThrow(
      'Contributor validation failed',
    );

    // No contributors should be installed after failed validation.
    expect(responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
  });

  it('throws on activation when createContributors factory rejects', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkg: KernelMakaioExtension = {
      name: 'ext-factory-fail',
      displayName: 'Factory Fail',
      version: '0.1.0',
      clientHookResponses: {
        createContributors: () => {
          throw new Error('factory boom');
        },
      },
    };

    await expect(processor.processActivated('ext-factory-fail', pkg, makeContext())).rejects.toThrow(
      'createContributors failed',
    );

    // No contributors should be installed.
    expect(responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
  });

  it("deactivation removes only that extension's contributors", async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkgA = makeExtension('ext-a', [makeContributor('hook-a')]);
    const pkgB = makeExtension('ext-b', [makeContributor('hook-b')]);

    await processor.processActivated('ext-a', pkgA, makeContext());
    await processor.processActivated('ext-b', pkgB, makeContext());

    expect(responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(2);

    await processor.processStopped?.('ext-a');

    const snapshot = responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.namespacedId).toBe('ext-b/hook-b');
  });

  it('disable then re-enable installs one fresh batch without duplication', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkg = makeExtension('ext-reenable', [makeContributor('hook-re')]);

    // Initial activation.
    await processor.processActivated('ext-reenable', pkg, makeContext());
    expect(responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(1);

    // Disable.
    await processor.processStopped?.('ext-reenable');
    expect(responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);

    // Re-enable.
    await processor.processActivated('ext-reenable', pkg, makeContext());
    const snapshot = responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.namespacedId).toBe('ext-reenable/hook-re');
  });

  it('shutdown removes all registrations via processStopped on each extension', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkgA = makeExtension('ext-a', [makeContributor('hook-a')]);
    const pkgB = makeExtension('ext-b', [makeContributor('hook-b')]);

    await processor.processActivated('ext-a', pkgA, makeContext());
    await processor.processActivated('ext-b', pkgB, makeContext());
    expect(responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(2);

    // Simulate coordinator shutdown: processStopped for each in reverse order.
    await processor.processStopped?.('ext-b');
    await processor.processStopped?.('ext-a');

    expect(responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
  });

  it('silently skips extensions without clientHookResponses', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkg = makeExtensionWithout('ext-no-hooks');

    // The filter should exclude this extension, but even if called
    // directly, processActivated should be a no-op.
    expect(processor.filter?.(pkg)).toBe(false);

    // Direct call should not throw or install anything.
    await processor.processActivated('ext-no-hooks', pkg, makeContext());
    expect(responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
  });

  it('filter returns true for extensions with clientHookResponses', () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkg = makeExtension('ext-with-hooks', [makeContributor('hook')]);
    expect(processor.filter?.(pkg)).toBe(true);
  });

  it('processStopped is safe for unknown extensions (no-op)', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    // Should not throw.
    await processor.processStopped?.('never-activated');
  });

  it('passes the activation context with correct extensionName and getProviderContract', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const catalog = makeCatalog();
    contractRegistry.registerProviderContract('provider-ext', catalog);

    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    let capturedCtx: ContributorActivationContext | undefined;
    const pkg: KernelMakaioExtension = {
      name: 'ext-ctx-test',
      displayName: 'Context Test',
      version: '0.1.0',
      clientHookResponses: {
        createContributors: (ctx) => {
          capturedCtx = ctx;
          return [makeContributor('hook-ctx')];
        },
      },
    };

    await processor.processActivated('ext-ctx-test', pkg, makeContext());

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.extensionName).toBe('ext-ctx-test');

    // The getProviderContract lookup requires the exact client and contract identities.
    const found = capturedCtx?.getProviderContract('claude-code', 'anthropic.tool-response');
    expect(found).toBeDefined();
    expect(found?.contractId).toBe('anthropic.tool-response');

    // Non-existent contract should return undefined.
    expect(capturedCtx?.getProviderContract('claude-code', 'nonexistent')).toBeUndefined();
  });

  it('handles async createContributors factory', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    const pkg: KernelMakaioExtension = {
      name: 'ext-async',
      displayName: 'Async Factory',
      version: '0.1.0',
      clientHookResponses: {
        createContributors: async () => [makeContributor('async-hook')],
      },
    };

    await processor.processActivated('ext-async', pkg, makeContext());

    const snapshot = responseRegistry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.namespacedId).toBe('ext-async/async-hook');
  });

  it('propagates errors from processStopped to the coordinator', async () => {
    const contractRegistry = new ClientHookProviderContractRegistry();
    const responseRegistry = new ClientHookResponseRegistry(contractRegistry);

    // Spy on removeContributors to simulate a failure.
    const removeSpy = vi.spyOn(responseRegistry, 'removeContributors').mockImplementation(() => {
      throw new Error('removal boom');
    });

    const processor = createClientHookResponseContributionProcessor(responseRegistry, contractRegistry);

    // The error should propagate — the coordinator handles processor errors.
    await expect(processor.processStopped?.('ext-error')).rejects.toThrow('removal boom');

    removeSpy.mockRestore();
  });
});

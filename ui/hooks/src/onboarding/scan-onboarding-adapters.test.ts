/**
 * Tests for scan-onboarding-adapters pure async functions.
 *
 * Uses real bus handlers registered on the singleton `MakaioBus` so that the
 * full request dispatch path — schema validation, handler lookup, result
 * propagation — is exercised instead of spying on `MakaioBus.request`.
 *
 * Handlers are torn down in `afterEach` via the unsubscribe functions returned
 * by `MakaioBus.on()`. `__resetHandlers` provides a defensive full reset before
 * each test in case a previous test leaked handlers.
 * @packageDocumentation
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { ClientStorageSubjects } from '@makaio/services-core/settings/storage';
import { SettingsSubjects } from '@makaio/services-core/settings/namespace';
import {
  buildScanContext,
  scanOnboarding,
  scanOnboardingAdapters,
  scanOnboardingClients,
} from './scan-onboarding-adapters.js';

/**
 * Minimal adapter info fixture satisfying `AdapterInfoSchema` required fields.
 * @param adapterName - Adapter driver name
 * @param clientId - Optional client identifier
 * @returns Minimal adapter info object
 */
function makeAdapterInfo(adapterName: string, clientId?: string) {
  return {
    adapterName,
    displayName: adapterName,
    enabled: true,
    configCount: 0,
    supportsLogImport: false,
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

beforeEach(() => {
  MakaioBus.__resetHandlers?.();
});

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('buildScanContext()', () => {
  // Per-test cleanups arrays are belt-and-suspenders: afterEach calls
  // MakaioBus.__resetHandlers() globally, so no handler leaks across
  // tests even if a test throws before reaching the cleanup loop.
  it('fetches clients + adapters, calls ClientSubjects.scan with the scannable targets, and returns enriched context', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({
          clients: [
            {
              id: 'claude-code',
              name: 'Claude Code',
              packageName: '@makaio/client-claude-code',
              binary: { name: 'claude', supportedVersions: '*' },
              enabled: true,
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              createdAt: 0,
              updatedAt: 0,
            },
            // Client with no binary — should be excluded from scan targets
            {
              id: 'web-only',
              name: 'Web Only',
              packageName: '@makaio/client-web-only',
              enabled: true,
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({
          adapters: [
            makeAdapterInfo('claude-code-cli', 'claude-code'),
            makeAdapterInfo('claude-agent-sdk', 'claude-code'),
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(ClientSubjects.scan, (ctx) => {
        expect(ctx.payload.targets).toEqual([
          { clientId: 'claude-code', binaryName: 'claude', supportedVersions: '*' },
        ]);
        ctx.setResult({
          results: [{ clientId: 'claude-code', found: true, version: '2.1.90', warningMessage: 'upgrade soon' }],
        });
      }),
    );

    const ctx = await buildScanContext();

    expect(ctx).toEqual({
      scannedClients: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          binary: 'claude',
          found: true,
          version: '2.1.90',
          warningMessage: 'upgrade soon',
        },
      ],
      adaptersByClientId: new Map([['claude-code', ['claude-code-cli', 'claude-agent-sdk']]]),
    });

    cleanups.forEach((fn) => fn());
  });

  it('returns null when no enabled clients have a binary', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({
          clients: [
            {
              id: 'web-only',
              name: 'Web Only',
              packageName: '@makaio/client-web-only',
              enabled: true,
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({ adapters: [] });
      }),
    );

    // ClientSubjects.scan must NOT be called when there are no scannable targets.
    // Registering a handler that throws ensures the assertion fires if scan is
    // incorrectly invoked.
    cleanups.push(
      MakaioBus.on(ClientSubjects.scan, (_ctx) => {
        throw new Error('client.scan must not be called when no clients have a binary');
      }),
    );

    await expect(buildScanContext()).resolves.toBeNull();

    cleanups.forEach((fn) => fn());
  });
});

describe('scanOnboardingAdapters()', () => {
  it('returns one enriched OnboardingAdapter per adapter with correct shape', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({
          clients: [
            {
              id: 'claude-code',
              name: 'Claude Code',
              packageName: '@makaio/client-claude-code',
              binary: { name: 'claude', supportedVersions: '*' },
              enabled: true,
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({
          adapters: [
            makeAdapterInfo('claude-agent-sdk', 'claude-code'),
            makeAdapterInfo('claude-code-cli', 'claude-code'),
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(ClientSubjects.scan, (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'claude-code', found: true, version: '2.1.90' }],
        });
      }),
    );

    const adapters = await scanOnboardingAdapters();

    // Both adapters inherit the client's scan result.
    // buildAdapterResults preserves insertion order (no sort — adapter order
    // follows the adapter list response).
    expect(adapters).toEqual([
      {
        adapterName: 'claude-agent-sdk',
        displayName: 'Claude Code',
        binary: 'claude',
        found: true,
        version: '2.1.90',
        warningMessage: undefined,
      },
      {
        adapterName: 'claude-code-cli',
        displayName: 'Claude Code',
        binary: 'claude',
        found: true,
        version: '2.1.90',
        warningMessage: undefined,
      },
    ]);

    cleanups.forEach((fn) => fn());
  });

  it('returns empty array when no scannable clients exist', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: [] });
      }),
    );

    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({ adapters: [] });
      }),
    );

    await expect(scanOnboardingAdapters()).resolves.toEqual([]);

    cleanups.forEach((fn) => fn());
  });

  it('omits clients that have no matching adapters', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({
          clients: [
            {
              id: 'codex',
              name: 'Codex',
              packageName: '@makaio/client-codex',
              binary: { name: 'codex', supportedVersions: '*' },
              enabled: true,
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        });
      }),
    );

    // No adapters mapped to 'codex'
    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({ adapters: [makeAdapterInfo('claude-code-cli', 'claude-code')] });
      }),
    );

    cleanups.push(
      MakaioBus.on(ClientSubjects.scan, (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'codex', found: true, version: '1.0.0' }],
        });
      }),
    );

    await expect(scanOnboardingAdapters()).resolves.toEqual([]);

    cleanups.forEach((fn) => fn());
  });
});

describe('scanOnboardingClients()', () => {
  it('returns one OnboardingClient per scanned client with sorted adapterNames', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({
          clients: [
            {
              id: 'claude-code',
              name: 'Claude Code',
              packageName: '@makaio/client-claude-code',
              binary: { name: 'claude', supportedVersions: '*' },
              enabled: true,
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        });
      }),
    );

    // Adapters returned in SDK-first order; expect CLI to sort first.
    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({
          adapters: [
            makeAdapterInfo('claude-agent-sdk', 'claude-code'),
            makeAdapterInfo('claude-code-cli', 'claude-code'),
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(ClientSubjects.scan, (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'claude-code', found: true, version: '2.1.90' }],
        });
      }),
    );

    const clients = await scanOnboardingClients();

    expect(clients).toEqual([
      {
        clientId: 'claude-code',
        name: 'Claude Code',
        binary: 'claude',
        found: true,
        version: '2.1.90',
        warningMessage: undefined,
        // CLI sorts before SDK per adapterSortPriority
        adapterNames: ['claude-code-cli', 'claude-agent-sdk'],
      },
    ]);

    cleanups.forEach((fn) => fn());
  });

  it('includes clients with no adapters and exposes an empty adapterNames array', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({
          clients: [
            {
              id: 'codex',
              name: 'Codex',
              packageName: '@makaio/client-codex',
              binary: { name: 'codex', supportedVersions: '*' },
              enabled: true,
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({ adapters: [] });
      }),
    );

    cleanups.push(
      MakaioBus.on(ClientSubjects.scan, (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'codex', found: false }],
        });
      }),
    );

    const clients = await scanOnboardingClients();

    expect(clients).toEqual([
      {
        clientId: 'codex',
        name: 'Codex',
        binary: 'codex',
        found: false,
        version: undefined,
        warningMessage: undefined,
        adapterNames: [],
      },
    ]);

    cleanups.forEach((fn) => fn());
  });

  it('returns empty array when no scannable clients exist', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: [] });
      }),
    );

    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({ adapters: [] });
      }),
    );

    await expect(scanOnboardingClients()).resolves.toEqual([]);

    cleanups.forEach((fn) => fn());
  });
});

describe('scanOnboarding()', () => {
  it('returns combined adapter and client results from a single scan context', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({
          clients: [
            {
              id: 'claude-code',
              name: 'Claude Code',
              packageName: '@makaio/client-claude-code',
              binary: { name: 'claude', supportedVersions: '*' },
              enabled: true,
              nativeTools: [],
              defaultApprovalPolicy: 'always-ask',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({
          adapters: [
            makeAdapterInfo('claude-agent-sdk', 'claude-code'),
            makeAdapterInfo('claude-code-cli', 'claude-code'),
          ],
        });
      }),
    );

    cleanups.push(
      MakaioBus.on(ClientSubjects.scan, (ctx) => {
        ctx.setResult({
          results: [{ clientId: 'claude-code', found: true, version: '2.1.90' }],
        });
      }),
    );

    const { adapters, clients } = await scanOnboarding();

    expect(adapters).toHaveLength(2);
    expect(clients).toHaveLength(1);
    expect(clients[0].adapterNames).toEqual(['claude-code-cli', 'claude-agent-sdk']);

    cleanups.forEach((fn) => fn());
  });

  it('returns empty adapters and clients when no scannable clients exist', async () => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
        ctx.setResult({ clients: [] });
      }),
    );

    cleanups.push(
      MakaioBus.on(SettingsSubjects.adapter.list, (ctx) => {
        ctx.setResult({ adapters: [] });
      }),
    );

    await expect(scanOnboarding()).resolves.toEqual({ adapters: [], clients: [] });

    cleanups.forEach((fn) => fn());
  });
});

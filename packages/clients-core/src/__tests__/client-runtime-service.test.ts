import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type ClientRuntimeStarted, type ClientUsageSnapshot } from '@makaio/contracts/client';
import { CLIDetectionSubjects, type CLIDetectionResult } from '@makaio/services-core/cli-detection/namespace';
import { ClientStorageSubjects, type ClientRecord } from '@makaio/services-core/settings/storage';
import { ClientAccountRegistry, ClientRuntimeService, createClientsCorePackage } from '../index.js';
import { makeClientRecord } from './helpers.js';

describe('ClientRuntimeService', () => {
  let bus: IMakaioBus;
  let service: ClientRuntimeService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new ClientRuntimeService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('account.observe reuses account IDs for repeated identifiers', async () => {
    const first = await bus.request(ClientSubjects.account.observe, {
      clientId: 'claude-code',
      displayLabel: 'Claude Team',
      identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
    });

    const second = await bus.request(ClientSubjects.account.observe, {
      clientId: 'claude-code',
      displayLabel: 'Claude Team Renamed',
      identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
    });

    expect(second.clientAccountId).toBe(first.clientAccountId);
    expect(second.displayLabel).toBe('Claude Team Renamed');
  });

  it('client account registry chooses generated canonical IDs by numeric sequence', () => {
    const registry = new ClientAccountRegistry();
    for (let index = 1; index <= 10; index += 1) {
      registry.upsertAccount({
        clientId: 'client-alpha',
        identifiers: [{ scheme: 'alias', value: `alias-${index}`, strength: 'alias' }],
      });
    }

    const result = registry.upsertAccount({
      clientId: 'client-alpha',
      identifiers: [
        { scheme: 'alias', value: 'alias-10', strength: 'alias' },
        { scheme: 'alias', value: 'alias-2', strength: 'alias' },
      ],
    });

    expect(result.clientAccountId).toBe('client-account-2');
  });

  it('usage.ingest emits usage.snapshot and reuses observed account IDs', async () => {
    const observed = await bus.request(ClientSubjects.account.observe, {
      clientId: 'codex',
      displayLabel: 'Primary Codex Account',
      identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
    });

    const emittedSnapshots: ClientUsageSnapshot[] = [];
    const cleanup = bus.on(ClientSubjects.usage.snapshot, ({ payload }) => {
      emittedSnapshots.push(payload);
    });

    const result = await bus.request(ClientSubjects.usage.ingest, {
      clientId: 'codex',
      observedAt: 1_713_795_200_000,
      source: 'statusline',
      account: {
        displayLabel: 'Primary Codex Account',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      },
      usage: {
        windows: [{ key: 'daily', label: 'Daily', usedPercentage: 42, resetsAt: 1_713_800_000_000 }],
      },
      metadata: { origin: 'unit-test' },
    });

    cleanup();

    expect(result.clientAccountId).toBe(observed.clientAccountId);
    expect(result.snapshot.clientAccountId).toBe(observed.clientAccountId);
    expect(emittedSnapshots).toEqual([result.snapshot]);
  });

  it('strong identifier evidence merges alias accounts and keeps the latest merged snapshot', async () => {
    const aliasOnly = await bus.request(ClientSubjects.usage.ingest, {
      clientId: 'claude-code',
      observedAt: 200,
      source: 'statusline',
      account: {
        displayLabel: 'Alias Account',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      },
      usage: {
        windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 25 }],
      },
    });

    const strongOnly = await bus.request(ClientSubjects.account.observe, {
      clientId: 'claude-code',
      displayLabel: 'Strong Account',
      identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
    });

    const merged = await bus.request(ClientSubjects.usage.ingest, {
      clientId: 'claude-code',
      observedAt: 100,
      source: 'statusline',
      account: {
        displayLabel: 'Strong Account',
        identifiers: [
          { scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' },
          { scheme: 'email', value: 'user@example.com', strength: 'alias' },
        ],
      },
      usage: {
        windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 10 }],
      },
    });

    expect(aliasOnly.clientAccountId).not.toBe(strongOnly.clientAccountId);
    expect(merged.clientAccountId).toBe(strongOnly.clientAccountId);
    expect(service.getLatestSnapshot(strongOnly.clientAccountId)?.observedAt).toBe(200);
    expect(service.getLatestSnapshot(aliasOnly.clientAccountId)).toBeUndefined();
  });

  it('account.observe emits a canonical usage snapshot when it merges an existing snapshot', async () => {
    const aliasOnly = await bus.request(ClientSubjects.usage.ingest, {
      clientId: 'claude-code',
      observedAt: 200,
      source: 'statusline',
      account: {
        displayLabel: 'Alias Account',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      },
      usage: {
        windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 25 }],
      },
    });

    const strongOnly = await bus.request(ClientSubjects.account.observe, {
      clientId: 'claude-code',
      displayLabel: 'Strong Account',
      identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
    });

    const emittedSnapshots: ClientUsageSnapshot[] = [];
    const cleanup = bus.on(ClientSubjects.usage.snapshot, ({ payload }) => {
      emittedSnapshots.push(payload);
    });

    const merged = await bus.request(ClientSubjects.account.observe, {
      clientId: 'claude-code',
      displayLabel: 'Strong Account',
      identifiers: [
        { scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' },
        { scheme: 'email', value: 'user@example.com', strength: 'alias' },
      ],
    });

    cleanup();

    expect(merged.clientAccountId).toBe(strongOnly.clientAccountId);
    expect(aliasOnly.clientAccountId).not.toBe(strongOnly.clientAccountId);
    expect(emittedSnapshots).toEqual([
      expect.objectContaining({
        clientAccountId: strongOnly.clientAccountId,
        observedAt: 200,
        displayLabel: 'Strong Account',
      }),
    ]);
  });

  it('account.observe re-emits the canonical snapshot when it retires an older merged account', async () => {
    const strongOnly = await bus.request(ClientSubjects.usage.ingest, {
      clientId: 'claude-code',
      observedAt: 200,
      source: 'statusline',
      account: {
        displayLabel: 'Strong Account',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      },
      usage: {
        windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 40 }],
      },
    });

    const aliasOnly = await bus.request(ClientSubjects.usage.ingest, {
      clientId: 'claude-code',
      observedAt: 100,
      source: 'statusline',
      account: {
        displayLabel: 'Alias Account',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      },
      usage: {
        windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 20 }],
      },
    });

    const emittedSnapshots: ClientUsageSnapshot[] = [];
    const cleanup = bus.on(ClientSubjects.usage.snapshot, ({ payload }) => {
      emittedSnapshots.push(payload);
    });

    const merged = await bus.request(ClientSubjects.account.observe, {
      clientId: 'claude-code',
      displayLabel: 'Strong Account',
      identifiers: [
        { scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' },
        { scheme: 'email', value: 'user@example.com', strength: 'alias' },
      ],
    });

    cleanup();

    expect(merged.clientAccountId).toBe(strongOnly.clientAccountId);
    expect(aliasOnly.clientAccountId).not.toBe(strongOnly.clientAccountId);
    expect(service.getLatestSnapshot(strongOnly.clientAccountId)?.observedAt).toBe(200);
    expect(service.getLatestSnapshot(aliasOnly.clientAccountId)).toBeUndefined();
    expect(emittedSnapshots).toEqual([
      expect.objectContaining({
        clientAccountId: strongOnly.clientAccountId,
        observedAt: 200,
        displayLabel: 'Strong Account',
      }),
    ]);
  });

  it('account.observe refreshes the retained snapshot label when only account metadata changes', async () => {
    const ingested = await bus.request(ClientSubjects.usage.ingest, {
      clientId: 'codex',
      observedAt: 300,
      source: 'statusline',
      account: {
        displayLabel: 'Old Label',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      },
      usage: {
        windows: [{ key: 'daily', label: 'Daily', usedPercentage: 50 }],
      },
    });

    const emittedSnapshots: ClientUsageSnapshot[] = [];
    const cleanup = bus.on(ClientSubjects.usage.snapshot, ({ payload }) => {
      emittedSnapshots.push(payload);
    });

    const observed = await bus.request(ClientSubjects.account.observe, {
      clientId: 'codex',
      displayLabel: 'New Label',
      identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
    });

    cleanup();

    expect(observed.clientAccountId).toBe(ingested.clientAccountId);
    expect(service.getLatestSnapshot(ingested.clientAccountId)?.displayLabel).toBe('New Label');
    expect(emittedSnapshots).toEqual([
      expect.objectContaining({
        clientAccountId: ingested.clientAccountId,
        observedAt: 300,
        displayLabel: 'New Label',
      }),
    ]);
  });

  it('client.scan derives results from storage and CLI detection with version warnings', async () => {
    const listedClients: ClientRecord[] = [
      makeClientRecord({
        id: 'codex',
        name: 'Codex',
        packageName: '@makaio/client-codex',
        enabled: true,
        binaryName: 'codex',
        minimumVersion: '1.2.0',
      }),
      makeClientRecord({
        id: 'claude-code',
        name: 'Claude Code',
        packageName: '@makaio/client-claude-code',
        enabled: true,
        binaryName: 'claude',
        minimumVersion: '2.0.0',
      }),
      makeClientRecord({
        id: 'disabled-client',
        name: 'Disabled Client',
        packageName: '@makaio/client-disabled',
        enabled: false,
        binaryName: 'disabled',
      }),
      makeClientRecord({
        id: 'web-client',
        name: 'Web Client',
        packageName: '@makaio/client-web',
        enabled: true,
      }),
    ];
    const detectionResults: CLIDetectionResult[] = [
      { binary: 'codex', found: true, version: '1.1.0' },
      { binary: 'claude', found: true, version: '2.0.0' },
    ];

    const cleanupList = bus.on(ClientStorageSubjects.list, (ctx) => {
      ctx.setResult({ clients: listedClients });
    });
    const cleanupScan = bus.on(CLIDetectionSubjects.scan, (ctx) => {
      expect(ctx.payload.binaries).toEqual(['codex', 'claude']);
      ctx.setResult({ results: detectionResults });
    });

    const result = await bus.request(ClientSubjects.scan, {});

    cleanupScan();
    cleanupList();

    expect(result.results).toEqual([
      {
        clientId: 'codex',
        found: true,
        version: '1.1.0',
        warningMessage: 'Recommended: v1.2.0+',
      },
      {
        clientId: 'claude-code',
        found: true,
        version: '2.0.0',
      },
    ]);
  });

  it('client.scan uses provided targets without reading client storage', async () => {
    const cleanupList = bus.on(ClientStorageSubjects.list, () => {
      throw new Error('Client storage should not be read when scan targets are supplied');
    });
    const cleanupScan = bus.on(CLIDetectionSubjects.scan, (ctx) => {
      expect(ctx.payload.binaries).toEqual(['codex']);
      ctx.setResult({ results: [{ binary: 'codex', found: true, version: '1.1.0' }] });
    });

    const result = await bus.request(ClientSubjects.scan, {
      targets: [{ clientId: 'codex', binaryName: 'codex', minimumVersion: '1.2.0' }],
    });

    cleanupScan();
    cleanupList();

    expect(result.results).toEqual([
      {
        clientId: 'codex',
        found: true,
        version: '1.1.0',
        warningMessage: 'Recommended: v1.2.0+',
      },
    ]);
  });

  it('client.scan compares versions that include prerelease or build metadata', async () => {
    const listedClients: ClientRecord[] = [
      makeClientRecord({
        id: 'codex',
        name: 'Codex',
        packageName: '@makaio/client-codex',
        enabled: true,
        binaryName: 'codex',
        minimumVersion: '1.2.0',
      }),
      makeClientRecord({
        id: 'claude-code',
        name: 'Claude Code',
        packageName: '@makaio/client-claude-code',
        enabled: true,
        binaryName: 'claude',
        minimumVersion: '2.0.0',
      }),
    ];
    const detectionResults: CLIDetectionResult[] = [
      { binary: 'codex', found: true, version: '1.1.0-beta.1' },
      { binary: 'claude', found: true, version: '2.0.0+build.3' },
    ];

    const cleanupList = bus.on(ClientStorageSubjects.list, (ctx) => {
      ctx.setResult({ clients: listedClients });
    });
    const cleanupScan = bus.on(CLIDetectionSubjects.scan, (ctx) => {
      expect(ctx.payload.binaries).toEqual(['codex', 'claude']);
      ctx.setResult({ results: detectionResults });
    });

    const result = await bus.request(ClientSubjects.scan, {});

    cleanupScan();
    cleanupList();

    expect(result.results).toEqual([
      {
        clientId: 'codex',
        found: true,
        version: '1.1.0-beta.1',
        warningMessage: 'Recommended: v1.2.0+',
      },
      {
        clientId: 'claude-code',
        found: true,
        version: '2.0.0+build.3',
      },
    ]);
  });

  it('exports a clients-core package factory', () => {
    const pkg = createClientsCorePackage();
    expect(pkg.name).toBeTruthy();
    expect(pkg.critical).toBe(true);
    expect(pkg.create).toBeTypeOf('function');
    expect(pkg.storage?.registerHandlers).toBeTypeOf('function');
  });

  describe('runtime.observe', () => {
    it('newly created runtime emits client.runtime.started and returns created=true', async () => {
      const emitted: ClientRuntimeStarted[] = [];
      const cleanup = bus.on(ClientSubjects.runtime.started, ({ payload }) => {
        emitted.push(payload);
      });

      const result = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'claude-code',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        observedAt: 1_700_000_000_000,
        supervisorSessionId: 'sup-session-1',
        pid: 12345,
      });

      cleanup();

      expect(result.created).toBe(true);
      expect(result.promoted).toBe(false);
      expect(typeof result.clientRuntimeId).toBe('string');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        clientRuntimeId: result.clientRuntimeId,
        clientId: 'claude-code',
        status: 'started',
        supervisorSessionId: 'sup-session-1',
        pid: 12345,
      });
    });

    it('newly observed pid-only runtime emits client.runtime.started with observed status', async () => {
      const emitted: ClientRuntimeStarted[] = [];
      const cleanup = bus.on(ClientSubjects.runtime.started, ({ payload }) => {
        emitted.push(payload);
      });

      const first = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'claude-code',
        source: { layer: 'statusline', producer: 'test-statusline' },
        observedAt: 1_700_000_000_000,
        pid: 9999,
      });

      expect(first.created).toBe(true);
      expect(first.promoted).toBe(false);
      expect(emitted).toEqual([
        expect.objectContaining({
          clientRuntimeId: first.clientRuntimeId,
          clientId: 'claude-code',
          status: 'observed',
          pid: 9999,
        }),
      ]);

      const second = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'claude-code',
        source: { layer: 'statusline', producer: 'test-statusline' },
        observedAt: 1_700_000_001_000,
        pid: 9999,
        cwd: '/home/user/project',
      });

      cleanup();

      expect(second.created).toBe(false);
      expect(second.promoted).toBe(false);
      expect(second.clientRuntimeId).toBe(first.clientRuntimeId);
      expect(emitted).toHaveLength(1);
    });

    it('promotion from observed to started emits client.runtime.started exactly once', async () => {
      const emitted: ClientRuntimeStarted[] = [];
      const cleanup = bus.on(ClientSubjects.runtime.started, ({ payload }) => {
        emitted.push(payload);
      });

      const first = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'codex',
        source: { layer: 'statusline', producer: 'test-statusline' },
        observedAt: 1_700_000_000_000,
        pid: 4321,
      });

      expect(first.created).toBe(true);
      expect(emitted).toHaveLength(1);

      const promoted = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'codex',
        source: { layer: 'adapter', producer: 'codex-adapter' },
        observedAt: 1_700_000_002_000,
        pid: 4321,
        adapterSessionId: 'adapter-session-42',
      });

      cleanup();

      expect(promoted.created).toBe(false);
      expect(promoted.promoted).toBe(true);
      expect(promoted.clientRuntimeId).toBe(first.clientRuntimeId);
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toMatchObject({
        clientRuntimeId: first.clientRuntimeId,
        clientId: 'codex',
        status: 'started',
        adapterSessionId: 'adapter-session-42',
      });
    });

    it('promotion emits client.runtime.started with enriched fields from prior observations', async () => {
      const emitted: ClientRuntimeStarted[] = [];
      const cleanup = bus.on(ClientSubjects.runtime.started, ({ payload }) => {
        emitted.push(payload);
      });

      const first = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'claude-code',
        source: { layer: 'statusline', producer: 'test-statusline' },
        observedAt: 1_700_000_000_000,
        pid: 7777,
        cwd: '/home/user/enriched-project',
      });

      expect(first.created).toBe(true);
      expect(emitted).toHaveLength(1);

      const promoted = await bus.request(ClientSubjects.runtime.observe, {
        clientId: 'claude-code',
        source: { layer: 'adapter', producer: 'claude-adapter' },
        observedAt: 1_700_000_003_000,
        pid: 7777,
        adapterSessionId: 'adapter-session-enriched',
      });

      cleanup();

      expect(promoted.created).toBe(false);
      expect(promoted.promoted).toBe(true);
      expect(promoted.clientRuntimeId).toBe(first.clientRuntimeId);
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toMatchObject({
        clientRuntimeId: first.clientRuntimeId,
        clientId: 'claude-code',
        status: 'started',
        adapterSessionId: 'adapter-session-enriched',
        cwd: '/home/user/enriched-project',
      });
    });

    it('rejects an observe request that lacks all hard-evidence fields', async () => {
      await expect(
        bus.request(ClientSubjects.runtime.observe, {
          clientId: 'claude-code',
          source: { layer: 'client-hook', producer: 'test-hook' },
          observedAt: 1_700_000_000_000,
          sessionId: 'session-only',
          cwd: '/home/user',
        }),
      ).rejects.toThrow('hard-evidence');
    });
  });

  describe('account.activate and account.getActive', () => {
    it('account.getActive returns null when no activation has been signalled', async () => {
      const result = await bus.request(ClientSubjects.account.getActive, {
        clientId: 'claude-code',
      });
      expect(result.identity).toBeNull();
    });

    it('account.activate stores the identity and account.getActive retrieves it', async () => {
      const activateResult = await bus.request(ClientSubjects.account.activate, {
        clientId: 'claude-code',
        clientAccountId: 'ca-activate-1',
        identifiers: [{ scheme: 'account-org-uuid', value: 'acct-1:org-1', strength: 'strong' }],
        displayLabel: 'Test User',
      });

      expect(activateResult.accepted).toBe(true);

      const getActiveResult = await bus.request(ClientSubjects.account.getActive, {
        clientId: 'claude-code',
      });

      expect(getActiveResult.identity).toEqual({
        clientAccountId: 'ca-activate-1',
        identifiers: [{ scheme: 'account-org-uuid', value: 'acct-1:org-1', strength: 'strong' }],
        displayLabel: 'Test User',
      });
    });

    it('account.activate overwrites a previous activation for the same clientId', async () => {
      await bus.request(ClientSubjects.account.activate, {
        clientId: 'claude-code',
        clientAccountId: 'ca-old',
        identifiers: [{ scheme: 'account-org-uuid', value: 'acct-old:org-old', strength: 'strong' }],
      });

      await bus.request(ClientSubjects.account.activate, {
        clientId: 'claude-code',
        clientAccountId: 'ca-new',
        identifiers: [{ scheme: 'account-org-uuid', value: 'acct-new:org-new', strength: 'strong' }],
        displayLabel: 'New User',
      });

      const result = await bus.request(ClientSubjects.account.getActive, { clientId: 'claude-code' });

      expect(result.identity?.clientAccountId).toBe('ca-new');
      expect(result.identity?.displayLabel).toBe('New User');
    });

    it('account.activate is keyed per clientId — different clients do not interfere', async () => {
      await bus.request(ClientSubjects.account.activate, {
        clientId: 'claude-code',
        clientAccountId: 'ca-claude',
        identifiers: [{ scheme: 'account-org-uuid', value: 'acct-claude:org-claude', strength: 'strong' }],
      });

      await bus.request(ClientSubjects.account.activate, {
        clientId: 'codex',
        clientAccountId: 'ca-codex',
        identifiers: [{ scheme: 'account-id', value: 'codex-acct-1', strength: 'strong' }],
      });

      const claudeResult = await bus.request(ClientSubjects.account.getActive, { clientId: 'claude-code' });
      const codexResult = await bus.request(ClientSubjects.account.getActive, { clientId: 'codex' });
      const unknownResult = await bus.request(ClientSubjects.account.getActive, { clientId: 'unknown-client' });

      expect(claudeResult.identity?.clientAccountId).toBe('ca-claude');
      expect(codexResult.identity?.clientAccountId).toBe('ca-codex');
      expect(unknownResult.identity).toBeNull();
    });

    it('account.getActive returns null after service destroy and reinit', async () => {
      await bus.request(ClientSubjects.account.activate, {
        clientId: 'claude-code',
        clientAccountId: 'ca-pre-destroy',
        identifiers: [{ scheme: 'account-org-uuid', value: 'acct-d:org-d', strength: 'strong' }],
      });

      await service.destroy();
      await service.init();

      const result = await bus.request(ClientSubjects.account.getActive, { clientId: 'claude-code' });
      expect(result.identity).toBeNull();
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  ClientAccountObserveSchema,
  ClientDefinitionSchema,
  ClientScanResultSchema,
  ClientSessionUsageSnapshotSchema,
  ClientUsageIngestSchema,
  ClientUsageSnapshotSchema,
} from '@makaio/contracts/client';

/** Minimal valid {@link ClientDefinitionSchema} input used by legacy rejection tests. */
const validDef = {
  id: 'test-client',
  name: 'Test Client',
  version: '0.1.0',
  defaultApprovalPolicy: 'always-ask',
} as const;

function createValidUsageIngestRequest() {
  return {
    clientId: 'client-alpha',
    observedAt: 1_713_795_200_000,
    source: 'hook',
    account: {
      displayLabel: 'Example Account',
      identifiers: [{ scheme: 'example.email', value: 'user@example.com', strength: 'alias' }],
    },
    usage: {
      windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 23.5, resetsAt: 1_738_425_600_000 }],
    },
    metadata: { sessionId: 'session-123' },
  };
}

function createValidUsageSnapshot() {
  return {
    clientAccountId: 'client-account-1',
    clientId: 'client-alpha',
    observedAt: 1_713_795_200_000,
    source: 'hook',
    displayLabel: 'Example Account',
    usage: {
      windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 23.5, resetsAt: 1_738_425_600_000 }],
    },
    metadata: { sessionId: 'session-123' },
  };
}

describe('client schemas', () => {
  it('rejects empty client scan clientId', () => {
    expect(ClientScanResultSchema.safeParse({ clientId: '', found: true }).success).toBe(false);
  });

  it('accepts only absolute executable paths in client scan results', () => {
    expect(
      ClientScanResultSchema.safeParse({ clientId: 'claude-code', found: true, binaryPath: '/opt/bin/claude' }).success,
    ).toBe(true);
    expect(
      ClientScanResultSchema.safeParse({ clientId: 'claude-code', found: true, binaryPath: 'bin/claude' }).success,
    ).toBe(false);
  });

  it('validates client.account.observe requests and responses', () => {
    const request = ClientAccountObserveSchema.request.parse({
      clientId: 'client-alpha',
      displayLabel: 'Example Account',
      identifiers: [{ scheme: 'example.account-org-id', value: 'acct-1:org-1', strength: 'strong' }],
      metadata: { source: 'profile' },
    });
    const response = ClientAccountObserveSchema.response.parse({
      clientAccountId: 'client-account-1',
      displayLabel: 'Example Account',
    });

    expect(request.identifiers).toHaveLength(1);
    expect(response.clientAccountId).toBe('client-account-1');
    expect(
      ClientAccountObserveSchema.request.safeParse({
        clientId: 'client-alpha',
        identifiers: [],
      }).success,
    ).toBe(false);
    expect(
      ClientAccountObserveSchema.request.safeParse({
        clientId: ' ',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      }).success,
    ).toBe(false);
    expect(
      ClientAccountObserveSchema.request.safeParse({
        clientId: 'client-alpha',
        identifiers: [{ scheme: ' ', value: 'user@example.com', strength: 'alias' }],
      }).success,
    ).toBe(false);
  });

  it('accepts valid client.usage.ingest requests', () => {
    const ingestRequest = ClientUsageIngestSchema.request.parse(createValidUsageIngestRequest());

    expect(ingestRequest.usage.windows[0]?.key).toBe('five-hour');
  });

  it('rejects client.usage.ingest when usedPercentage is above 100', () => {
    expect(
      ClientUsageIngestSchema.request.safeParse({
        ...createValidUsageIngestRequest(),
        usage: {
          windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 140 }],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects client.usage.ingest when numeric fields are not finite', () => {
    expect(
      ClientUsageIngestSchema.request.safeParse({
        ...createValidUsageIngestRequest(),
        observedAt: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
    expect(
      ClientUsageIngestSchema.request.safeParse({
        ...createValidUsageIngestRequest(),
        usage: {
          windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: Number.POSITIVE_INFINITY }],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects client.usage.ingest when source is empty', () => {
    expect(
      ClientUsageIngestSchema.request.safeParse({
        ...createValidUsageIngestRequest(),
        source: '',
      }).success,
    ).toBe(false);
  });

  it('accepts valid client usage snapshots', () => {
    const snapshot = ClientUsageSnapshotSchema.parse(createValidUsageSnapshot());

    expect(snapshot.clientAccountId).toBe('client-account-1');
  });

  it('rejects client usage snapshots when clientAccountId is blank', () => {
    expect(
      ClientUsageSnapshotSchema.safeParse({
        ...createValidUsageSnapshot(),
        clientAccountId: ' ',
      }).success,
    ).toBe(false);
  });

  it('accepts content-free interactive session usage snapshots', () => {
    const snapshot = ClientSessionUsageSnapshotSchema.parse({
      clientId: 'claude-code',
      clientAccountId: 'client-account-1',
      adapterSessionId: 'native-session-1',
      source: 'statusline',
      observedAt: 1_713_795_200_000,
      clientVersion: '2.1.132',
      modelId: 'claude-opus-4-6',
      latestRequestInputTokens: 120,
      latestRequestOutputTokens: 45,
      latestRequestCacheReadTokens: 2_400,
      latestRequestCacheWriteTokens: 80,
      currentContextInputTokens: 80_000,
      currentContextOutputTokens: 4_000,
      contextWindowSizeTokens: 200_000,
      contextUsedPercentage: 42,
      totalCost: 12.68,
      costCurrency: 'USD',
      costProvenance: 'client-reported',
      totalDurationMs: 3_933_000,
      totalApiDurationMs: 348_000,
      totalLinesAdded: 82,
      totalLinesRemoved: 1,
    });

    expect(snapshot.latestRequestCacheReadTokens).toBe(2_400);
    expect(snapshot.currentContextInputTokens).toBe(80_000);
    expect(snapshot.totalCost).toBe(12.68);
  });

  it('rejects content fields and invalid measurements in session usage snapshots', () => {
    const base = {
      clientId: 'claude-code',
      adapterSessionId: 'native-session-1',
      source: 'statusline',
      observedAt: 1_713_795_200_000,
      latestRequestInputTokens: 120,
    };

    expect(ClientSessionUsageSnapshotSchema.safeParse({ ...base, prompt: 'private prompt' }).success).toBe(false);
    expect(ClientSessionUsageSnapshotSchema.safeParse({ ...base, transcriptPath: '/private/transcript' }).success).toBe(
      false,
    );
    expect(ClientSessionUsageSnapshotSchema.safeParse({ ...base, latestRequestInputTokens: -1 }).success).toBe(false);
    expect(ClientSessionUsageSnapshotSchema.safeParse({ ...base, contextUsedPercentage: 101 }).success).toBe(false);
    expect(ClientSessionUsageSnapshotSchema.safeParse({ ...base, totalCost: Number.NaN }).success).toBe(false);
  });

  it('requires session cost amount, currency, and provenance as one coherent group', () => {
    const base = {
      clientId: 'claude-code',
      adapterSessionId: 'native-session-1',
      source: 'statusline',
      observedAt: 1_713_795_200_000,
      latestRequestInputTokens: 120,
    };

    expect(ClientSessionUsageSnapshotSchema.safeParse(base).success).toBe(true);
    expect(ClientSessionUsageSnapshotSchema.safeParse({ ...base, totalCost: 1, costCurrency: 'USD' }).success).toBe(
      false,
    );
    expect(
      ClientSessionUsageSnapshotSchema.safeParse({ ...base, totalCost: 1, costProvenance: 'estimated' }).success,
    ).toBe(false);
    expect(
      ClientSessionUsageSnapshotSchema.safeParse({
        ...base,
        costCurrency: 'USD',
        costProvenance: 'estimated',
      }).success,
    ).toBe(false);
  });
});

describe('legacy field rejection', () => {
  it('rejects a client definition without a version', () => {
    const { version: _version, ...input } = validDef;
    expect(ClientDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects legacy binaryName', () => {
    const input = { ...validDef, binaryName: 'claude' };
    expect(ClientDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects legacy minimumVersion', () => {
    const input = { ...validDef, minimumVersion: '1.0.0' };
    expect(ClientDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects binary preferredVersion', () => {
    const input = {
      ...validDef,
      binary: { name: 'test', supportedVersions: '>=1.0.0', preferredVersion: '1.2.3' },
    };
    expect(ClientDefinitionSchema.safeParse(input).success).toBe(false);
  });
});

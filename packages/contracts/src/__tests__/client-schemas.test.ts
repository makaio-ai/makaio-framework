import { describe, expect, it } from 'vitest';
import {
  ClientAccountObserveSchema,
  ClientScanResultSchema,
  ClientUsageIngestSchema,
  ClientUsageSnapshotSchema,
} from '@makaio/contracts/client';

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
});

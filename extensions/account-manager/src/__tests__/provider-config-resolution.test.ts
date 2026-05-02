import { describe, it, expect, afterEach } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ClientStorageSubjects } from '@makaio/services-core/settings/storage';
import { buildAccountManagerCredentialRef } from '@makaio/contracts/config';
import { resolveProviderConfigsForAccount } from '../provider-config-resolution.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = 'claude-code';
const ACCOUNT_ID = 'acc-test-123';

/**
 * The `account-manager:["claude-code","acc-test-123"]` credential ref string
 * that provider configs use to bind to this account.
 */
const ACCOUNT_REF = buildAccountManagerCredentialRef(CLIENT_ID, ACCOUNT_ID);

/**
 * Builds a minimal client record for use with `ClientStorageSubjects.get`.
 * @param defaultProviderId - The default provider ID for the client
 * @returns A valid ClientRecord-shaped object
 */
function makeClientRecord(defaultProviderId: string) {
  return {
    id: CLIENT_ID,
    packageName: '@makaio/client-claude-code',
    name: 'Claude Code',
    defaultApprovalPolicy: 'always-ask' as const,
    nativeTools: [],
    defaultProviderId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('resolveProviderConfigsForAccount', () => {
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups = [];
  });

  it('returns empty array when the adapter subsystem is unavailable', async () => {
    const bus = createBusInstance();
    // No handlers registered — requestOptional returns handled=false.
    const result = await resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID);
    expect(result).toEqual([]);
  });

  it('returns direct sourceRef match when the config refs this account', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: 'cfg-direct',
              definitionId: 'anthropic',
              name: 'Work Account',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: ACCOUNT_REF,
            },
          ],
        });
      }),
    );

    const result = await resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      providerConfigId: 'cfg-direct',
      definitionId: 'anthropic',
      isSentinel: false,
    });
  });

  it('returns sentinel fallback when the client defaultProviderId matches and no direct ref exists', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: 'cfg-sentinel',
              definitionId: 'anthropic',
              name: 'Claude Code (auto)',
              modelFilterMode: 'show-all' as const,
              isDefault: true,
              enabled: true,
              isSentinel: true,
              hasCredentials: false,
            },
          ],
        });
      }),
      bus.on(ClientStorageSubjects.get, (ctx) => {
        ctx.setResult({ client: makeClientRecord('anthropic') });
      }),
    );

    const result = await resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      providerConfigId: 'cfg-sentinel',
      definitionId: 'anthropic',
      isSentinel: true,
    });
  });

  it('returns empty array when no configs match and only a non-sentinel config exists', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: 'cfg-other',
              definitionId: 'openai',
              name: 'OpenAI Config',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: 'account-manager:["other-client","other-account"]',
            },
          ],
        });
      }),
      bus.on(ClientStorageSubjects.get, (ctx) => {
        ctx.setResult({ client: makeClientRecord('anthropic') });
      }),
    );

    const result = await resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID);
    expect(result).toEqual([]);
  });

  it('falls back to direct sourceRef matching only when the client record is missing', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: 'cfg-direct',
              definitionId: 'anthropic',
              name: 'Work Account',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: ACCOUNT_REF,
            },
            {
              id: 'cfg-sentinel',
              definitionId: 'anthropic',
              name: 'Claude Code (auto)',
              modelFilterMode: 'show-all' as const,
              isDefault: true,
              enabled: true,
              isSentinel: true,
              hasCredentials: false,
            },
          ],
        });
      }),
      // ClientStorageSubjects.get returns handled=false (no client record).
    );

    // Without a client record, only direct sourceRef match should work.
    const result = await resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].providerConfigId).toBe('cfg-direct');
  });

  it('ignores sentinel configs when definitionId does not match client defaultProviderId', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: 'cfg-sentinel-openai',
              definitionId: 'openai',
              name: 'OpenAI (auto)',
              modelFilterMode: 'show-all' as const,
              isDefault: true,
              enabled: true,
              isSentinel: true,
              hasCredentials: false,
            },
          ],
        });
      }),
      bus.on(ClientStorageSubjects.get, (ctx) => {
        // Client's defaultProviderId is 'anthropic', not 'openai'.
        ctx.setResult({ client: makeClientRecord('anthropic') });
      }),
    );

    const result = await resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID);
    expect(result).toEqual([]);
  });

  it('returns direct matches before sentinel fallbacks when both apply', async () => {
    const bus = createBusInstance();
    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: 'cfg-sentinel',
              definitionId: 'anthropic',
              name: 'Claude Code (auto)',
              modelFilterMode: 'show-all' as const,
              isDefault: true,
              enabled: true,
              isSentinel: true,
              hasCredentials: false,
            },
            {
              id: 'cfg-direct',
              definitionId: 'anthropic',
              name: 'Work Account',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: ACCOUNT_REF,
            },
          ],
        });
      }),
      bus.on(ClientStorageSubjects.get, (ctx) => {
        ctx.setResult({ client: makeClientRecord('anthropic') });
      }),
    );

    const result = await resolveProviderConfigsForAccount(bus, CLIENT_ID, ACCOUNT_ID);
    expect(result.map((r) => r.providerConfigId)).toEqual(['cfg-direct', 'cfg-sentinel']);
  });
});

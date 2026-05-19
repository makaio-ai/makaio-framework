/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { MakaioBus, createBusInstance } from '@makaio/bus-core';
import { CredentialSubjects, SessionSubjects } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { resetCredentialChangeSequences } from '@makaio/services-core/credential-change';
import { ClientStorageSubjects } from '@makaio/services-core/settings/storage';
import { AccountManagerSubjects } from '../bus/namespace.js';
import { CredentialRefSchema } from '@makaio/contracts/config';
import type { RawCredential } from '../interfaces/credential-source.js';
import { AccountManager } from '../account-manager.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

/**
 * Creates a test credential with a deterministic fingerprint derived from the token.
 * @param token - Token string to use as the credential payload
 * @param meta - Optional metadata
 * @returns A RawCredential with a computed fingerprint
 */
function makeCredential(token: string, meta: Record<string, unknown> = {}): RawCredential {
  return {
    token,
    fingerprint: computeFingerprint(token),
    metadata: meta,
  };
}

describe('AccountManager', () => {
  let source: InMemoryCredentialSource;
  let store: InMemoryAccountStore;
  let service: AccountManager;

  beforeEach(async () => {
    jest.useFakeTimers();
    resetCredentialChangeSequences(MakaioBus);
    source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    store = new InMemoryAccountStore();
    service = new AccountManager(MakaioBus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    jest.useRealTimers();
  });

  describe('bus handlers', () => {
    it('listAccounts returns public accounts without credentials', async () => {
      const cred = makeCredential('token-1');
      source.setCredential(cred);
      await jest.advanceTimersByTime(1000);

      const result = await MakaioBus.request(AccountManagerSubjects.accounts.list, {
        clientId: 'claude-code',
      });

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].id).toMatch(/^[0-9a-f-]+$/);
      // Stored credential must not appear in the public response
      expect('credential' in result.accounts[0]).toBe(false);
    });

    it('getActiveAccount returns the active account', async () => {
      const cred = makeCredential('token-1');
      source.setCredential(cred);
      await jest.advanceTimersByTime(1000);

      const result = await MakaioBus.request(AccountManagerSubjects.accounts.getActive, {
        clientId: 'claude-code',
      });

      expect(result.account).not.toBeNull();
      expect(result.account!.id).toMatch(/^[0-9a-f-]+$/);
      expect(result.account!.active).toBe(true);
    });

    it('getActiveAccount returns null when no accounts exist', async () => {
      const result = await MakaioBus.request(AccountManagerSubjects.accounts.getActive, {
        clientId: 'claude-code',
      });
      expect(result.account).toBeNull();
    });

    it('getSources returns available sources', async () => {
      const result = await MakaioBus.request(AccountManagerSubjects.accounts.getSources, {});
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]).toMatchObject({
        clientId: 'claude-code',
        displayName: 'Claude Code',
        available: true,
      });
    });

    it('credential.activate writes the requested account-manager account to native storage', async () => {
      const TARGET_ID = '00000000-0000-0000-0000-000000000001';
      const target = makeCredential('token-target');
      await store.upsert('claude-code', {
        id: TARGET_ID,
        fingerprint: target.fingerprint,
        label: 'Target',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: target,
      });
      source.setCredential(makeCredential('token-other'));

      await MakaioBus.request(CredentialSubjects.activate, {
        providerConfigId: 'provider-config-1',
        definitionId: 'anthropic',
        credentialRefs: {
          token: `account-manager:["claude-code","${TARGET_ID}"]`,
        },
      });

      expect(source.getLastWritten()).toEqual(target);
      const active = (await store.list('claude-code')).find((account) => account.active);
      expect(active?.id).toBe(TARGET_ID);
    });

    it('credential.activate refreshes the credential before writing', async () => {
      const TARGET_ID = '00000000-0000-0000-0000-000000000005';
      const expired = makeCredential('token-expired');
      const refreshed = makeCredential('token-refreshed');

      await store.upsert('claude-code', {
        id: TARGET_ID,
        fingerprint: expired.fingerprint,
        label: 'Expired Account',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: expired,
      });

      // source.read() returns null — no different keychain credential to adopt.
      // refreshIfNeeded is the only upgrade path.
      source.setCredential(null);
      source.setRefreshHandler(async () => ({ status: 'refreshed', credential: refreshed }));

      await MakaioBus.request(CredentialSubjects.activate, {
        providerConfigId: 'provider-config-1',
        definitionId: 'anthropic',
        credentialRefs: {
          token: `account-manager:["claude-code","${TARGET_ID}"]`,
        },
      });

      expect(source.getLastWritten()).toEqual(refreshed);
    });

    it('ignores definition fallback for provider configs not owned by account-manager', async () => {
      const ORIGINAL_ID = '00000000-0000-0000-0000-000000000002';
      const OTHER_ID = '00000000-0000-0000-0000-000000000003';
      const original = makeCredential('token-original');
      const other = makeCredential('token-other');
      await store.upsert('claude-code', {
        id: ORIGINAL_ID,
        fingerprint: original.fingerprint,
        label: 'Original',
        metadata: {},
        active: true,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: original,
      });
      await store.upsert('claude-code', {
        id: OTHER_ID,
        fingerprint: other.fingerprint,
        label: 'Other',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: other,
      });
      source.setCredential(original);

      const cleanups = [
        MakaioBus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
          ctx.setResult({
            configs: [
              {
                id: 'provider-config-1',
                definitionId: 'anthropic',
                name: 'Regular provider config',
                modelFilterMode: 'show-all',
                isDefault: true,
                enabled: true,
                isSentinel: false,
                hasCredentials: true,
              },
            ],
          });
        }),
        MakaioBus.on(ClientStorageSubjects.list, (ctx) => {
          ctx.setResult({
            clients: [
              {
                id: 'claude-code',
                packageName: '@makaio/client-claude-code',
                name: 'Claude Code',
                defaultApprovalPolicy: 'always-ask',
                nativeTools: [],
                defaultProviderId: 'anthropic',
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          });
        }),
      ];

      try {
        await MakaioBus.request(CredentialSubjects.activate, {
          providerConfigId: 'provider-config-1',
          definitionId: 'anthropic',
          credentialRefs: {},
        });

        expect(source.getLastWritten()).toBeUndefined();
        const active = (await store.list('claude-code')).find((account) => account.active);
        expect(active?.id).toBe(ORIGINAL_ID);
      } finally {
        cleanups.forEach((cleanup) => cleanup());
      }
    });

    it('switchAccount emits credential.changed for matching active sessions', async () => {
      const ACCOUNT_A_ID = '00000000-0000-0000-0000-00000000000a';
      const ACCOUNT_B_ID = '00000000-0000-0000-0000-00000000000b';
      const credA = makeCredential('token-a');
      const credB = makeCredential('token-b');
      await store.upsert('claude-code', {
        id: ACCOUNT_A_ID,
        fingerprint: credA.fingerprint,
        label: 'A',
        metadata: {},
        active: true,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: credA,
      });
      await store.upsert('claude-code', {
        id: ACCOUNT_B_ID,
        fingerprint: credB.fingerprint,
        label: 'B',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: credB,
      });

      const cleanups = [
        MakaioBus.on(ClientStorageSubjects.get, (ctx) => {
          ctx.setResult({
            client: {
              id: 'claude-code',
              packageName: '@makaio/client-claude-code',
              name: 'Claude Code',
              defaultApprovalPolicy: 'always-ask',
              nativeTools: [],
              defaultProviderId: 'anthropic',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          });
        }),
        MakaioBus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
          ctx.setResult({
            configs: [
              {
                id: 'cfg-account',
                definitionId: 'anthropic',
                name: 'Work',
                modelFilterMode: 'show-all',
                isDefault: false,
                enabled: true,
                isSentinel: false,
                hasCredentials: true,
                sourceRef: `account-manager:["claude-code","${ACCOUNT_B_ID}"]`,
              },
              {
                id: 'cfg-sentinel',
                definitionId: 'anthropic',
                name: 'Claude Code (auto)',
                modelFilterMode: 'show-all',
                isDefault: true,
                enabled: true,
                isSentinel: true,
                hasCredentials: false,
              },
            ],
          });
        }),
        MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
          if (ctx.payload.providerConfigId === 'cfg-account') {
            ctx.setResult({
              context: {
                providerConfigId: 'cfg-account',
                definitionId: 'anthropic',
                credentialRefs: {
                  token: CredentialRefSchema.parse(`account-manager:["claude-code","${ACCOUNT_B_ID}"]`),
                },
              },
            });
            return;
          }
          ctx.setResult({
            context: {
              providerConfigId: 'cfg-sentinel',
              definitionId: 'anthropic',
              credentialRefs: {},
            },
          });
        }),
        MakaioBus.on(SessionSubjects.list, (ctx) => {
          ctx.setResult({
            sessions: [
              {
                sessionId: 'session-1',
                createdAt: 1,
                lastActivityAt: 1,
                status: 'active',
                agents: [
                  {
                    agentId: 'agent-1',
                    adapterId: 'adapter-1',
                    adapterName: 'claude-code-cli',
                    sessionId: 'session-1',
                    role: 'lead',
                    status: 'idle',
                    createdAt: 1,
                    lastActivityAt: 1,
                    providerConfigId: 'cfg-account',
                  },
                  {
                    agentId: 'agent-2',
                    adapterId: 'adapter-2',
                    adapterName: 'claude-code-cli',
                    sessionId: 'session-1',
                    role: 'member',
                    status: 'idle',
                    createdAt: 1,
                    lastActivityAt: 1,
                    providerConfigId: 'cfg-sentinel',
                  },
                ],
              },
            ],
            total: 1,
          });
        }),
      ];

      const changedPayloads: unknown[] = [];
      const changedCleanup = MakaioBus.on(CredentialSubjects.changed, (ctx) => {
        changedPayloads.push(ctx.payload);
        ctx.setResult({});
      });

      try {
        const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
          clientId: 'claude-code',
          accountId: ACCOUNT_B_ID,
        });

        expect(result.success).toBe(true);
        expect(changedPayloads).toEqual([
          {
            sessionId: 'session-1',
            providerConfigId: 'cfg-account',
            definitionId: 'anthropic',
            changeSequence: 1,
            credentialRefs: {
              token: `account-manager:["claude-code","${ACCOUNT_B_ID}"]`,
            },
          },
          {
            sessionId: 'session-1',
            providerConfigId: 'cfg-sentinel',
            definitionId: 'anthropic',
            changeSequence: 1,
            credentialRefs: {},
          },
        ]);
      } finally {
        changedCleanup();
        cleanups.forEach((cleanup) => cleanup());
      }
    });

    it('switchAccount continues credential fan-out when one relevant provider config disappears', async () => {
      const ACCOUNT_A_ID = '00000000-0000-0000-0000-00000000001a';
      const ACCOUNT_B_ID = '00000000-0000-0000-0000-00000000001b';
      const credA = makeCredential('token-a-fanout');
      const credB = makeCredential('token-b-fanout');
      await store.upsert('claude-code', {
        id: ACCOUNT_A_ID,
        fingerprint: credA.fingerprint,
        label: 'A',
        metadata: {},
        active: true,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: credA,
      });
      await store.upsert('claude-code', {
        id: ACCOUNT_B_ID,
        fingerprint: credB.fingerprint,
        label: 'B',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: credB,
      });

      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      const cleanups = [
        MakaioBus.on(ClientStorageSubjects.get, (ctx) => {
          ctx.setResult({
            client: {
              id: 'claude-code',
              packageName: '@makaio/client-claude-code',
              name: 'Claude Code',
              defaultApprovalPolicy: 'always-ask',
              nativeTools: [],
              defaultProviderId: 'anthropic',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          });
        }),
        MakaioBus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
          ctx.setResult({
            configs: [
              {
                id: 'cfg-broken',
                definitionId: 'anthropic',
                name: 'Broken Work',
                modelFilterMode: 'show-all',
                isDefault: false,
                enabled: true,
                isSentinel: false,
                hasCredentials: true,
                sourceRef: `account-manager:["claude-code","${ACCOUNT_B_ID}"]`,
              },
              {
                id: 'cfg-good',
                definitionId: 'anthropic',
                name: 'Good Work',
                modelFilterMode: 'show-all',
                isDefault: false,
                enabled: true,
                isSentinel: false,
                hasCredentials: true,
                sourceRef: `account-manager:["claude-code","${ACCOUNT_B_ID}"]`,
              },
            ],
          });
        }),
        MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
          if (ctx.payload.providerConfigId === 'cfg-broken') {
            ctx.setResult({ context: null });
            return;
          }
          ctx.setResult({
            context: {
              providerConfigId: 'cfg-good',
              definitionId: 'anthropic',
              credentialRefs: {
                token: CredentialRefSchema.parse(`account-manager:["claude-code","${ACCOUNT_B_ID}"]`),
              },
            },
          });
        }),
        MakaioBus.on(SessionSubjects.list, (ctx) => {
          ctx.setResult({
            sessions: [
              {
                sessionId: 'session-broken',
                createdAt: 1,
                lastActivityAt: 1,
                status: 'active',
                agents: [
                  {
                    agentId: 'agent-broken',
                    adapterId: 'adapter-1',
                    adapterName: 'claude-code-cli',
                    sessionId: 'session-broken',
                    role: 'lead',
                    status: 'idle',
                    createdAt: 1,
                    lastActivityAt: 1,
                    providerConfigId: 'cfg-broken',
                  },
                ],
              },
              {
                sessionId: 'session-good',
                createdAt: 1,
                lastActivityAt: 1,
                status: 'active',
                agents: [
                  {
                    agentId: 'agent-good',
                    adapterId: 'adapter-2',
                    adapterName: 'claude-code-cli',
                    sessionId: 'session-good',
                    role: 'lead',
                    status: 'idle',
                    createdAt: 1,
                    lastActivityAt: 1,
                    providerConfigId: 'cfg-good',
                  },
                ],
              },
            ],
            total: 2,
          });
        }),
      ];

      const changedPayloads: unknown[] = [];
      const changedCleanup = MakaioBus.on(CredentialSubjects.changed, (ctx) => {
        changedPayloads.push(ctx.payload);
        ctx.setResult({});
      });

      try {
        const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
          clientId: 'claude-code',
          accountId: ACCOUNT_B_ID,
        });

        expect(result.success).toBe(true);
        expect(changedPayloads).toEqual([
          {
            sessionId: 'session-good',
            providerConfigId: 'cfg-good',
            definitionId: 'anthropic',
            changeSequence: 1,
            credentialRefs: {
              token: `account-manager:["claude-code","${ACCOUNT_B_ID}"]`,
            },
          },
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toBe(
          '[AccountManager] provider config disappeared during credential fan-out:',
        );
        expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
          clientId: 'claude-code',
          providerConfigId: 'cfg-broken',
        });
      } finally {
        changedCleanup();
        cleanups.forEach((cleanup) => cleanup());
        warnSpy.mockRestore();
      }
    });

    it('switchAccount fails when provider-context assembly errors for a surviving config', async () => {
      const ACCOUNT_A_ID = '00000000-0000-0000-0000-00000000001a';
      const ACCOUNT_B_ID = '00000000-0000-0000-0000-00000000001b';
      const credA = makeCredential('token-a-broken-context');
      const credB = makeCredential('token-b-broken-context');
      await store.upsert('claude-code', {
        id: ACCOUNT_A_ID,
        fingerprint: credA.fingerprint,
        label: 'A',
        metadata: {},
        active: true,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: credA,
      });
      await store.upsert('claude-code', {
        id: ACCOUNT_B_ID,
        fingerprint: credB.fingerprint,
        label: 'B',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: credB,
      });

      const cleanups = [
        MakaioBus.on(ClientStorageSubjects.get, (ctx) => {
          ctx.setResult({
            client: {
              id: 'claude-code',
              packageName: '@makaio/client-claude-code',
              name: 'Claude Code',
              defaultApprovalPolicy: 'always-ask',
              nativeTools: [],
              defaultProviderId: 'anthropic',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          });
        }),
        MakaioBus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
          ctx.setResult({
            configs: [
              {
                id: 'cfg-broken',
                definitionId: 'anthropic',
                name: 'Broken config',
                sourceRef: `account-manager:["claude-code","${ACCOUNT_B_ID}"]`,
                modelFilterMode: 'show-all',
                isDefault: true,
                enabled: true,
                isSentinel: false,
                hasCredentials: true,
              },
            ],
          });
        }),
        MakaioBus.on(SessionSubjects.list, (ctx) => {
          ctx.setResult({
            sessions: [
              {
                sessionId: 'session-broken',
                createdAt: 1,
                lastActivityAt: 1,
                status: 'active',
                agents: [
                  {
                    agentId: 'agent-broken',
                    adapterId: 'adapter-1',
                    adapterName: 'claude-code',
                    sessionId: 'session-broken',
                    role: 'lead',
                    status: 'idle',
                    createdAt: 1,
                    lastActivityAt: 1,
                    providerConfigId: 'cfg-broken',
                  },
                ],
              },
            ],
            total: 1,
          });
        }),
        MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, () => {
          throw new Error('provider definition unavailable');
        }),
      ];

      try {
        const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
          clientId: 'claude-code',
          accountId: ACCOUNT_B_ID,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('provider definition unavailable');
      } finally {
        cleanups.forEach((cleanup) => cleanup());
      }
    });

    it('switchAccount emits credential.changed once per session and provider config when matches overlap', async () => {
      const ACCOUNT_A_ID = '00000000-0000-0000-0000-00000000002a';
      const ACCOUNT_B_ID = '00000000-0000-0000-0000-00000000002b';
      const credA = makeCredential('token-a-overlap');
      const credB = makeCredential('token-b-overlap');
      await store.upsert('claude-code', {
        id: ACCOUNT_A_ID,
        fingerprint: credA.fingerprint,
        label: 'A',
        metadata: {},
        active: true,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: credA,
      });
      await store.upsert('claude-code', {
        id: ACCOUNT_B_ID,
        fingerprint: credB.fingerprint,
        label: 'B',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: credB,
      });

      const cleanups = [
        MakaioBus.on(ClientStorageSubjects.get, (ctx) => {
          ctx.setResult({
            client: {
              id: 'claude-code',
              packageName: '@makaio/client-claude-code',
              name: 'Claude Code',
              defaultApprovalPolicy: 'always-ask',
              nativeTools: [],
              defaultProviderId: 'anthropic',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          });
        }),
        MakaioBus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
          const overlappingConfig = {
            id: 'cfg-overlap',
            definitionId: 'anthropic',
            name: 'Overlap',
            modelFilterMode: 'show-all' as const,
            isDefault: false,
            enabled: true,
            isSentinel: false,
            hasCredentials: true,
            sourceRef: `account-manager:["claude-code","${ACCOUNT_B_ID}"]`,
          };
          ctx.setResult({
            configs: [overlappingConfig, { ...overlappingConfig }],
          });
        }),
        MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
          ctx.setResult({
            context: {
              providerConfigId: 'cfg-overlap',
              definitionId: 'anthropic',
              credentialRefs: {
                token: CredentialRefSchema.parse(`account-manager:["claude-code","${ACCOUNT_B_ID}"]`),
              },
            },
          });
        }),
        MakaioBus.on(SessionSubjects.list, (ctx) => {
          ctx.setResult({
            sessions: [
              {
                sessionId: 'session-overlap',
                createdAt: 1,
                lastActivityAt: 1,
                status: 'active',
                agents: [
                  {
                    agentId: 'agent-overlap',
                    adapterId: 'adapter-1',
                    adapterName: 'claude-code-cli',
                    sessionId: 'session-overlap',
                    role: 'lead',
                    status: 'idle',
                    createdAt: 1,
                    lastActivityAt: 1,
                    providerConfigId: 'cfg-overlap',
                  },
                ],
              },
            ],
            total: 1,
          });
        }),
      ];

      const changedPayloads: unknown[] = [];
      const changedCleanup = MakaioBus.on(CredentialSubjects.changed, (ctx) => {
        changedPayloads.push(ctx.payload);
        ctx.setResult({});
      });

      try {
        const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
          clientId: 'claude-code',
          accountId: ACCOUNT_B_ID,
        });

        expect(result.success).toBe(true);
        expect(changedPayloads).toEqual([
          {
            sessionId: 'session-overlap',
            providerConfigId: 'cfg-overlap',
            definitionId: 'anthropic',
            changeSequence: 1,
            credentialRefs: {
              token: `account-manager:["claude-code","${ACCOUNT_B_ID}"]`,
            },
          },
        ]);
      } finally {
        changedCleanup();
        cleanups.forEach((cleanup) => cleanup());
      }
    });

    it('labelAccount updates the account label', async () => {
      const cred = makeCredential('token-1');
      source.setCredential(cred);
      await jest.advanceTimersByTime(1000);

      const detectedAccounts = await store.list('claude-code');
      const detectedId = detectedAccounts[0].id;

      const result = await MakaioBus.request(AccountManagerSubjects.accounts.label, {
        clientId: 'claude-code',
        accountId: detectedId,
        label: 'Work',
      });

      expect(result.success).toBe(true);

      const accounts = await store.list('claude-code');
      expect(accounts[0].label).toBe('Work');
    });

    it('removeAccount removes the account', async () => {
      const cred = makeCredential('token-1');
      source.setCredential(cred);
      await jest.advanceTimersByTime(1000);

      const detectedAccounts = await store.list('claude-code');
      const detectedId = detectedAccounts[0].id;

      const result = await MakaioBus.request(AccountManagerSubjects.accounts.remove, {
        clientId: 'claude-code',
        accountId: detectedId,
      });

      expect(result.success).toBe(true);

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(0);
    });

    it('configureFileMode returns error for unsupported clients', async () => {
      const result = await MakaioBus.request(AccountManagerSubjects.credentials.configureFileMode, {
        clientId: 'claude-code',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('configureFileMode returns success when source implements the method', async () => {
      let called = false;

      /** Extends the base in-memory source with a configureFileMode implementation. */
      class FileModeSupportedSource extends InMemoryCredentialSource {
        async configureFileMode(): Promise<void> {
          called = true;
        }
      }

      // Use an isolated bus instance so this handler does not collide with the
      // outer service's configureFileMode handler registered on MakaioBus.
      const isolatedBus = createBusInstance();
      const fileModeSource = new FileModeSupportedSource('claude-code-fm', 'Claude Code FM');
      const fileModeStore = new InMemoryAccountStore();
      const fileModeService = new AccountManager(isolatedBus, {
        sources: [fileModeSource],
        credentialStore: fileModeStore.credentialStore,
        metadataStore: fileModeStore.metadataStore,
        usageSnapshotStore: fileModeStore.usageSnapshotStore,
        pollIntervalMs: 1000,
        makaioCommand: 'makaio-test',
      });
      await fileModeService.init();

      try {
        const result = await isolatedBus.request(AccountManagerSubjects.credentials.configureFileMode, {
          clientId: 'claude-code-fm',
        });
        expect(result.success).toBe(true);
        expect(called).toBe(true);
      } finally {
        await fileModeService.destroy();
      }
    });
  });
});

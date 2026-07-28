import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ContainerAdapterAuthEnvelopeSchema,
  ContainerBootstrapConfigSchema,
  ContainerBootstrapSpawnRequestSchema,
  ContainerIsolatedExecutionTargetSchema,
  ContainerIsolatedSpawnRequestSchema,
  ContainerLocalSpawnRequestSchema,
  type ContainerIsolatedSpawnRequest,
  type ContainerLocalSpawnRequest,
  type SpawnRequest,
} from '@makaio/services-core/execution-target';

const sessionRuntime = {
  machineId: 'session-container:machine-1',
  packageNames: ['provider-openai-codex', 'adapter-codex-app-server'],
} as const;

const adapterAuth = {
  selector: {
    sessionId: 'session-1',
    adapterName: 'codex-app-server',
    providerConfigId: 'provider-config-1',
    definitionId: 'openai-codex',
    runtime: sessionRuntime,
    auth: {
      mode: 'explicit' as const,
      method: {
        owner: 'provider' as const,
        providerDefinitionId: 'openai-codex',
        methodId: 'api-key',
      },
    },
  },
  scrubEnvVars: ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'],
  processEnv: { CODEX_ACCESS_TOKEN: 'access-token' },
  connectorDeliveries: [
    {
      target: 'codex.account-login.api-key',
      values: { apiKey: 'sk-test', enabled: true, retryCount: 0, opposingToken: null },
    },
  ],
};

describe('ContainerBootstrapConfigSchema', () => {
  describe('valid payloads', () => {
    it('accepts an empty object (all fields optional)', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });

    it('accepts a full normalized payload', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({
        busAuthSecret: 'hmac-secret-abc',
        gitToken: 'ghp_token123',
        runtimeEnv: { CUSTOM_VAR: 'private-runtime-value' },
        sessionRuntime,
        adapterAuth,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.busAuthSecret).toBe('hmac-secret-abc');
        expect(result.data.gitToken).toBe('ghp_token123');
        expect(result.data.runtimeEnv).toEqual({ CUSTOM_VAR: 'private-runtime-value' });
        expect(result.data.sessionRuntime).toEqual(sessionRuntime);
        expect(result.data.adapterAuth).toEqual(adapterAuth);
      }
    });

    it('accepts gitToken only', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({ gitToken: 'ghp_abc' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.gitToken).toBe('ghp_abc');
        expect(result.data.busAuthSecret).toBeUndefined();
      }
    });
  });

  describe('invalid payloads', () => {
    it('rejects a non-string gitToken', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({ gitToken: 42 });
      expect(result.success).toBe(false);
    });

    it.each(['credentialEnv', 'providerEnv'])('rejects the legacy %s plaintext map', (field) => {
      expect(ContainerBootstrapConfigSchema.safeParse({ [field]: { KEY: 'secret' } }).success).toBe(false);
    });

    it('rejects the retired relay handshake material', () => {
      expect(
        ContainerBootstrapConfigSchema.safeParse({
          busAuthSecret: 'hmac-secret-abc',
          relayPeer: { id: 'host-machine-1', signingPublicKey: 'host-signing-public-key' },
        }).success,
      ).toBe(false);
      expect(
        ContainerBootstrapConfigSchema.safeParse({
          busAuthSecret: 'hmac-secret-abc',
          relayIdentity: {
            id: 'wfx-1',
            signingPublicKey: 'worker-signing-public-key',
            signingPrivateKeyPem: 'worker-signing-private-key',
          },
        }).success,
      ).toBe(false);
    });

    it('rejects non-object input', () => {
      const result = ContainerBootstrapConfigSchema.safeParse('not-an-object');
      expect(result.success).toBe(false);
    });
  });

  describe('optional-field round-trip', () => {
    it('round-trips a sparse payload without adding unexpected fields', () => {
      const input = { gitToken: 'tok' };
      const result = ContainerBootstrapConfigSchema.parse(input);
      expect(result).toEqual({ gitToken: 'tok' });
      expect(Object.keys(result)).toEqual(['gitToken']);
    });
  });

  it('accepts the additive normalized adapter auth envelope', () => {
    expect(ContainerAdapterAuthEnvelopeSchema.parse(adapterAuth)).toEqual(adapterAuth);
  });

  it('rejects inferred auth because native client state is not container-portable', () => {
    expect(
      ContainerAdapterAuthEnvelopeSchema.safeParse({
        ...adapterAuth,
        selector: {
          ...adapterAuth.selector,
          auth: { ...adapterAuth.selector.auth, mode: 'inferred' },
        },
      }).success,
    ).toBe(false);
  });

  it('requires a unique non-empty session package selection', () => {
    expect(
      ContainerBootstrapConfigSchema.safeParse({
        sessionRuntime: { machineId: 'machine-1', packageNames: ['provider', 'provider'] },
      }).success,
    ).toBe(false);
    expect(
      ContainerBootstrapConfigSchema.safeParse({ sessionRuntime: { machineId: 'machine-1', packageNames: [] } })
        .success,
    ).toBe(false);
  });

  it('rejects provider-owned auth selected for a different provider definition', () => {
    expect(
      ContainerAdapterAuthEnvelopeSchema.safeParse({
        ...adapterAuth,
        selector: { ...adapterAuth.selector, definitionId: 'different-provider' },
      }).success,
    ).toBe(false);
  });

  it('rejects plaintext bootstrapConfig on the public Docker descriptor', () => {
    expect(
      ContainerLocalSpawnRequestSchema.safeParse({
        mode: 'container-local',
        sessionId: 'session-1',
        adapter: 'claude-code',
        repoPath: '/repo',
        baseBranch: 'main',
        bootstrapConfig: { gitToken: 'must-not-be-public' },
      }).success,
    ).toBe(false);
  });

  it('requires container-local workflow identities to be complete', () => {
    const descriptor = {
      mode: 'container-local' as const,
      sessionId: 'session-1',
      adapter: 'claude-code',
      repoPath: '/repo',
      baseBranch: 'main',
    };

    expect(ContainerLocalSpawnRequestSchema.safeParse(descriptor).success).toBe(true);
    expect(ContainerLocalSpawnRequestSchema.safeParse({ ...descriptor, executionId: 'execution-1' }).success).toBe(
      false,
    );
    expect(ContainerLocalSpawnRequestSchema.safeParse({ ...descriptor, executionAttemptId: 'attempt-1' }).success).toBe(
      false,
    );
    expect(
      ContainerLocalSpawnRequestSchema.safeParse({
        ...descriptor,
        executionId: 'execution-1',
        executionAttemptId: 'attempt-1',
      }).success,
    ).toBe(true);

    expectTypeOf<
      Pick<Extract<ContainerLocalSpawnRequest, { executionId: string }>, 'executionId' | 'executionAttemptId'>
    >().toEqualTypeOf<{ executionId: string; executionAttemptId: string }>();
  });

  it.each([
    'CUSTOM_VAR',
    'MAKAIO_GIT_TOKEN',
    'MAKAIO_BUS_AUTH_SECRET',
  ])('rejects arbitrary public env key %s because names cannot prove values are secret-free', (key) => {
    const result = ContainerLocalSpawnRequestSchema.safeParse({
      mode: 'container-local',
      sessionId: 'session-1',
      adapter: 'claude-code',
      repoPath: '/repo',
      baseBranch: 'main',
      env: { [key]: 'must-not-be-public' },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain('must-not-be-public');
  });

  it('correlates private adapter auth with the public session and adapter descriptor', () => {
    const request = {
      descriptor: {
        mode: 'container-local' as const,
        sessionId: 'session-1',
        adapter: 'codex-app-server',
        repoPath: '/repo',
        baseBranch: 'main',
      },
      bootstrapConfig: { sessionRuntime, adapterAuth },
    };

    expect(ContainerBootstrapSpawnRequestSchema.safeParse(request).success).toBe(true);
    expect(
      ContainerBootstrapSpawnRequestSchema.safeParse({
        ...request,
        descriptor: { ...request.descriptor, sessionId: 'wrong-session' },
      }).success,
    ).toBe(false);
    expect(
      ContainerBootstrapSpawnRequestSchema.safeParse({
        ...request,
        descriptor: { ...request.descriptor, adapter: 'wrong-adapter' },
      }).success,
    ).toBe(false);
  });

  it('binds private adapter auth to the exact session runtime identity and package order', () => {
    const request = {
      descriptor: {
        mode: 'container-local' as const,
        sessionId: 'session-1',
        adapter: 'codex-app-server',
        repoPath: '/repo',
        baseBranch: 'main',
      },
      bootstrapConfig: { sessionRuntime, adapterAuth },
    };

    expect(
      ContainerBootstrapSpawnRequestSchema.safeParse({
        ...request,
        bootstrapConfig: {
          ...request.bootstrapConfig,
          sessionRuntime: { ...sessionRuntime, machineId: 'session-container:other-machine' },
        },
      }).success,
    ).toBe(false);
    expect(
      ContainerBootstrapSpawnRequestSchema.safeParse({
        ...request,
        bootstrapConfig: {
          ...request.bootstrapConfig,
          sessionRuntime: { ...sessionRuntime, packageNames: [...sessionRuntime.packageNames].reverse() },
        },
      }).success,
    ).toBe(false);
    expect(
      ContainerBootstrapSpawnRequestSchema.safeParse({
        ...request,
        bootstrapConfig: { adapterAuth },
      }).success,
    ).toBe(false);
  });

  describe('public isolated-container URLs', () => {
    const isolatedDescriptor = {
      mode: 'container-isolated' as const,
      sessionId: 'session-1',
      adapter: 'codex-app-server',
    };
    const isolatedExecutionTarget = {
      id: 'target-1',
      name: 'Isolated',
      type: 'container-isolated' as const,
      scope: 'default',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };

    it.each([
      'https://github.com/makaio-ai/makaio.git',
      'http://git.example.test/makaio.git',
      'git://git.example.test/makaio.git',
      'ssh://git@git.example.test/makaio.git',
      'git@git.example.test:makaio/makaio.git',
      'https://git.example.test/makaio@archive.git',
    ])('accepts credential-free Git remote %s', (repoUrl) => {
      expect(ContainerIsolatedSpawnRequestSchema.safeParse({ ...isolatedDescriptor, repoUrl }).success).toBe(true);
    });

    it('rejects workflow execution identities structurally', () => {
      const result = ContainerIsolatedSpawnRequestSchema.safeParse({
        ...isolatedDescriptor,
        repoUrl: 'https://git.example.test/makaio.git',
        executionId: 'execution-1',
        executionAttemptId: 'attempt-1',
      });

      expect(result.success).toBe(false);
      expectTypeOf<Extract<ContainerIsolatedSpawnRequest, { executionId: unknown }>>().toBeNever();
      expectTypeOf<Extract<ContainerIsolatedSpawnRequest, { executionAttemptId: unknown }>>().toBeNever();
      expectTypeOf<
        Extract<SpawnRequest, { mode: 'container-isolated' }>
      >().toEqualTypeOf<ContainerIsolatedSpawnRequest>();
    });

    it('applies the same credential-free URL contract to persisted execution targets', () => {
      expect(
        ContainerIsolatedExecutionTargetSchema.safeParse({
          ...isolatedExecutionTarget,
          repoUrl: 'ssh://git@git.example.test/makaio.git',
        }).success,
      ).toBe(true);

      const secret = 'target-secret-must-not-echo';
      const result = ContainerIsolatedExecutionTargetSchema.safeParse({
        ...isolatedExecutionTarget,
        repoUrl: `https://user:${secret}@git.example.test/makaio.git`,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain(secret);
    });

    it.each([
      'https://git-user:repo-secret-must-not-echo@git.example.test/makaio.git',
      'https://git.example.test/makaio.git?token=repo-secret-must-not-echo',
      'https:git.example.test/repo-secret-must-not-echo',
      'file:///repo-secret-must-not-echo',
    ])('rejects secret-bearing or unsupported public repoUrl without reflecting its value', (repoUrl) => {
      const result = ContainerIsolatedSpawnRequestSchema.safeParse({ ...isolatedDescriptor, repoUrl });

      expect(result.success).toBe(false);
      if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain('must-not-echo');
    });

    it('rejects the retired relay bus coordinates on the public descriptor', () => {
      const base = { ...isolatedDescriptor, repoUrl: 'https://git.example.test/makaio.git' };
      expect(ContainerIsolatedSpawnRequestSchema.safeParse({ ...base, busMode: 'relay' }).success).toBe(false);
      expect(
        ContainerIsolatedSpawnRequestSchema.safeParse({ ...base, relayUrl: 'wss://relay.example.test/socket' }).success,
      ).toBe(false);
    });
  });

  it('requires selected process auth variables to be included in the scrub set', () => {
    expect(
      ContainerAdapterAuthEnvelopeSchema.safeParse({
        ...adapterAuth,
        scrubEnvVars: ['OPENAI_API_KEY'],
      }).success,
    ).toBe(false);
  });
});

import { z } from 'zod';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ALLOCATION_STATES,
  AllocationInspectionSchema,
  AllocationStateSchema,
  BoundedRecoveryEvidenceSchema,
  ProviderAllocationRefError,
  boundedProviderEvidence,
  createAllocationRefCodec,
  MATERIALIZATION_MODES,
  MaterializationModeSchema,
  PROVIDER_ALLOCATION_REF_VERSION,
  PROVISIONING_DISCOVERY_KINDS,
  ProvisioningDiscoverySchema,
  RECOVERY_EVIDENCE_LIMITS,
  WORKER_NODE_ALLOCATION_LIFETIMES,
  WORKER_NODE_CAPABILITY_ID,
  LocalDirectoryMaterializationSchema,
  OutcomeAckDecisionSchema,
  ProviderAllocationRefSchema,
  WorkerContributionRefSchema,
  WorkerMaterializationSpecSchema,
  WorkerNodeAllocationLifetimeSchema,
  WorkerNodeCapabilitiesSchema,
  WorkerNodeRequirementsSchema,
  WorkspaceSnapshotMaterializationSchema,
} from '../index.js';
import { SuspensionStrategySchema } from '../../../worker-node/suspension.js';
import type { SuspensionStrategy } from '../../../worker-node/suspension.js';
import type { WorkerNodeCapabilitiesInput } from '../types.js';
import type {
  AllocationInspection,
  AllocationState,
  BoundedRecoveryEvidence,
  IRecoverableWorkerNodeProvider,
  IWorkerNodeProvider,
  IWorkerNodeRecoveryCapability,
  OutcomeAckDecision,
  ProviderAllocationRef,
  ProvisioningDiscovery,
  WorkerContributionRef,
  WorkerMaterializationSpec,
  WorkerNodeAllocationLifetime,
  WorkerNodeCapabilities,
  WorkerNodeHandle,
  WorkerNodeProvisionOutcome,
  WorkerNodeProvisionRequest,
  WorkerNodeRequirements,
} from '../index.js';

/** Bounded evidence fixture reused by outcome and discovery assertions. */
const EVIDENCE: BoundedRecoveryEvidence = {
  source: 'fly.machines',
  summary: 'Validation rejected the request before any remote call was made.',
  observedAt: '2026-07-23T10:00:00Z',
};

describe('worker-node capability contracts', () => {
  it('uses the stable worker-node capability id', () => {
    expect(WORKER_NODE_CAPABILITY_ID).toBe('worker-node');
  });

  it('validates minimal worker-node capabilities', () => {
    const parsed = WorkerNodeCapabilitiesSchema.parse({
      persistentStorage: false,
      customCapabilities: ['workflow.bus-events'],
    });

    expect(parsed).toEqual({
      persistentStorage: false,
      customCapabilities: ['workflow.bus-events'],
      suspensionStrategy: 'wait-in-process',
      supportsRecovery: false,
      materializationModes: ['local-directory'],
    });
  });

  it('allows callers to omit capability arrays that schemas default', () => {
    const capabilities = { persistentStorage: true } satisfies WorkerNodeCapabilitiesInput;
    const requirements = { persistentStorage: true } satisfies WorkerNodeRequirements;

    expect(WorkerNodeCapabilitiesSchema.parse(capabilities)).toEqual({
      persistentStorage: true,
      customCapabilities: [],
      suspensionStrategy: 'wait-in-process',
      supportsRecovery: false,
      materializationModes: ['local-directory'],
    });
    expect(requirements).toEqual({ persistentStorage: true });
  });

  it('defaults worker-node suspension to in-process waiting', () => {
    expect(SuspensionStrategySchema.parse('exit-and-redispatch')).toBe('exit-and-redispatch');
    expect(WorkerNodeCapabilitiesSchema.parse({ persistentStorage: true })).toEqual({
      persistentStorage: true,
      customCapabilities: [],
      suspensionStrategy: 'wait-in-process',
      supportsRecovery: false,
      materializationModes: ['local-directory'],
    });
  });

  it('requires providers to expose normalized capabilities', () => {
    expectTypeOf<WorkerNodeCapabilities['suspensionStrategy']>().toEqualTypeOf<SuspensionStrategy>();

    const provider: IWorkerNodeProvider = {
      id: 'test.worker-node',
      displayName: 'Test WorkerNode',
      environment: 'test',
      allocationLifetime: 'provisioner-process-bound',
      baseCapabilities: WorkerNodeCapabilitiesSchema.parse({ persistentStorage: true }),
      provision: async (): Promise<WorkerNodeProvisionOutcome> => {
        throw new Error('not used');
      },
    };

    expectTypeOf(provider.baseCapabilities.suspensionStrategy).toEqualTypeOf<SuspensionStrategy>();
    expect(provider.baseCapabilities.suspensionStrategy).toBe('wait-in-process');
  });
});

describe('WorkerNodeProvisionRequest uses executionAttemptId', () => {
  it('requires executionAttemptId on provision requests', () => {
    const request: WorkerNodeProvisionRequest = {
      executionId: 'exec-1',
      executionAttemptId: 'attempt-1',
      environment: 'piscina',
      workerConfig: {} as WorkerNodeProvisionRequest['workerConfig'],
      workerManifest: { contributionRefs: [] },
      provisioningStartedAt: '2026-07-23T10:00:00Z',
    };

    expect(request.executionAttemptId).toBe('attempt-1');
    expect(request.executionId).toBe('exec-1');
  });

  it('does not have the old nodeId field', () => {
    expectTypeOf<WorkerNodeProvisionRequest>().not.toHaveProperty('nodeId');
  });

  it('requires the provisioning instant a bounded remote search is floored at', () => {
    // A clock-derived stand-in computes a floor that can exclude the attempt's
    // own allocation, so the field carries no `undefined` for a caller to
    // substitute one into.
    expectTypeOf<WorkerNodeProvisionRequest['provisioningStartedAt']>().toEqualTypeOf<string>();
  });
});

describe('WorkerNodeHandle is allocation-only', () => {
  it('carries executionAttemptId instead of nodeId', () => {
    const handle: WorkerNodeHandle = {
      executionAttemptId: 'attempt-1',
      cancel: async () => {},
      terminate: async () => {},
      release: async () => {},
    };

    expect(handle.executionAttemptId).toBe('attempt-1');
    expectTypeOf<WorkerNodeHandle>().not.toHaveProperty('nodeId');
  });

  it('does not expose a ready promise', () => {
    expectTypeOf<WorkerNodeHandle>().not.toHaveProperty('ready');
  });

  it('does not expose waitForResult', () => {
    expectTypeOf<WorkerNodeHandle>().not.toHaveProperty('waitForResult');
  });

  it('exposes cancel, terminate, and release methods', () => {
    expectTypeOf<WorkerNodeHandle['cancel']>().toEqualTypeOf<(reason?: string) => Promise<void>>();
    expectTypeOf<WorkerNodeHandle['terminate']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<WorkerNodeHandle['release']>().toEqualTypeOf<() => Promise<void>>();
  });
});

describe('IWorkerNodeProvider provision contract', () => {
  it('requires AbortSignal as second argument to provision', () => {
    const provider: IWorkerNodeProvider = {
      id: 'test.provider',
      displayName: 'Test Provider',
      environment: 'test',
      allocationLifetime: 'provider-managed',
      baseCapabilities: WorkerNodeCapabilitiesSchema.parse({ persistentStorage: false }),
      provision: async (_request, _signal) => ({
        kind: 'allocated' as const,
        allocationRef: {
          version: PROVIDER_ALLOCATION_REF_VERSION,
          providerId: 'test.provider',
          providerData: { machineId: 'machine-1' },
        },
        handle: {
          executionAttemptId: 'attempt-1',
          cancel: async () => {},
          terminate: async () => {},
          release: async () => {},
        },
      }),
    };

    expectTypeOf(provider.provision).parameters.toEqualTypeOf<[WorkerNodeProvisionRequest, AbortSignal]>();
  });

  it('returns allocationRef and handle from provision', async () => {
    const provider: IWorkerNodeProvider = {
      id: 'test.provider',
      displayName: 'Test Provider',
      environment: 'test',
      allocationLifetime: 'provider-managed',
      baseCapabilities: WorkerNodeCapabilitiesSchema.parse({ persistentStorage: false }),
      provision: async () => ({
        kind: 'allocated' as const,
        allocationRef: {
          version: PROVIDER_ALLOCATION_REF_VERSION,
          providerId: 'test.provider',
          providerData: { instanceId: 'i-123' },
        },
        handle: {
          executionAttemptId: 'attempt-1',
          cancel: async () => {},
          terminate: async () => {},
          release: async () => {},
        },
      }),
    };

    const result = await provider.provision(
      {
        executionId: 'exec-1',
        executionAttemptId: 'attempt-1',
        environment: 'test',
        workerConfig: {} as WorkerNodeProvisionRequest['workerConfig'],
        workerManifest: { contributionRefs: [] },
        provisioningStartedAt: '2026-07-23T10:00:00Z',
      },
      AbortSignal.timeout(5000),
    );

    expect(result.kind).toBe('allocated');
    if (result.kind !== 'allocated') throw new Error('expected an allocated outcome');
    expect(result.allocationRef.version).toBe(PROVIDER_ALLOCATION_REF_VERSION);
    expect(result.allocationRef.providerId).toBe('test.provider');
    expect(result.handle.executionAttemptId).toBe('attempt-1');
  });

  it('does not expose resumeExecution', () => {
    expectTypeOf<IWorkerNodeProvider>().not.toHaveProperty('resumeExecution');
  });
});

describe('ProviderAllocationRef', () => {
  it('validates a well-formed allocation reference', () => {
    const ref: ProviderAllocationRef = {
      version: PROVIDER_ALLOCATION_REF_VERSION,
      providerId: 'fly.machines',
      providerData: { machineId: 'machine-abc', region: 'iad' },
    };

    const parsed = ProviderAllocationRefSchema.parse(ref);
    expect(parsed.version).toBe(1);
    expect(parsed.providerId).toBe('fly.machines');
    expect(parsed.providerData).toEqual({ machineId: 'machine-abc', region: 'iad' });
  });

  it('has version fixed at PROVIDER_ALLOCATION_REF_VERSION', () => {
    expect(PROVIDER_ALLOCATION_REF_VERSION).toBe(1);
    expect(() =>
      ProviderAllocationRefSchema.parse({
        version: 2,
        providerId: 'fly',
        providerData: {},
      }),
    ).toThrow();
  });

  it('rejects missing providerId', () => {
    expect(() =>
      ProviderAllocationRefSchema.parse({
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerData: {},
      }),
    ).toThrow();
  });

  it('rejects empty providerId', () => {
    expect(() =>
      ProviderAllocationRefSchema.parse({
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: '',
        providerData: {},
      }),
    ).toThrow();
  });

  it('rejects unknown fields (strict envelope)', () => {
    expect(() =>
      ProviderAllocationRefSchema.parse({
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'fly',
        providerData: {},
        secretToken: 'should-fail',
      }),
    ).toThrow();
  });

  it('is JSON-serializable', () => {
    const ref: ProviderAllocationRef = {
      version: PROVIDER_ALLOCATION_REF_VERSION,
      providerId: 'github-actions',
      providerData: { runId: 12345, jobName: 'workflow-worker' },
    };

    const roundTripped = JSON.parse(JSON.stringify(ref));
    expect(ProviderAllocationRefSchema.parse(roundTripped)).toEqual(ref);
  });
});

describe('createAllocationRefCodec', () => {
  const ProviderDataSchema = z.object({ machineId: z.string().min(1), region: z.string().optional() }).strict();

  it('round-trips everything it builds', () => {
    const codec = createAllocationRefCodec('test.allocator', ProviderDataSchema);

    const ref = codec.build({ machineId: 'machine-1', region: 'iad' });

    expect(ref).toEqual({
      version: PROVIDER_ALLOCATION_REF_VERSION,
      providerId: 'test.allocator',
      providerData: { machineId: 'machine-1', region: 'iad' },
    });
    expect(ProviderAllocationRefSchema.parse(ref)).toEqual(ref);
    expect(codec.parse(ref)).toEqual({ machineId: 'machine-1', region: 'iad' });
  });

  it('rejects provider data its own schema rejects, rather than emitting an unparseable ref', () => {
    const codec = createAllocationRefCodec('test.allocator', ProviderDataSchema);

    expect(() => codec.build({ machineId: '' })).toThrow();
  });

  it('rejects provider-schema output that cannot cross the JSON envelope boundary', () => {
    const codec = createAllocationRefCodec(
      'test.allocator',
      z.object({ machineId: z.string(), callback: z.function() }),
    );

    expect(() => codec.build({ machineId: 'machine-1', callback: () => undefined })).toThrow();
  });

  it('rejects a reference whose envelope version is not the current one', () => {
    const codec = createAllocationRefCodec('test.allocator', ProviderDataSchema);
    const nextVersionRef = {
      ...codec.build({ machineId: 'machine-1' }),
      version: 999 as number,
    } as ProviderAllocationRef;

    expect(() => codec.parse(nextVersionRef)).toThrow(ProviderAllocationRefError);
  });

  it('rejects a reference owned by a different provider', () => {
    const codec = createAllocationRefCodec('test.allocator', ProviderDataSchema);

    expect(() =>
      codec.parse({
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'other.allocator',
        providerData: { machineId: 'machine-1' },
      }),
    ).toThrow(ProviderAllocationRefError);
  });

  it('rejects malformed provider data before any dereference', () => {
    const codec = createAllocationRefCodec('test.allocator', ProviderDataSchema);

    expect(() =>
      codec.parse({
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'test.allocator',
        providerData: { machineId: 42 },
      }),
    ).toThrow(ProviderAllocationRefError);
  });

  it('refuses a provider identity that could never appear in a reference', () => {
    expect(() => createAllocationRefCodec('', ProviderDataSchema)).toThrow();
  });
});

describe('boundedProviderEvidence', () => {
  it('returns evidence the durable schema accepts', () => {
    const evidence = boundedProviderEvidence('test.allocator', 'pre-request-rejection', 'nothing was created');

    expect(BoundedRecoveryEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(evidence.code).toBe('pre-request-rejection');
  });

  it('omits the code when the observation carries none', () => {
    const evidence = boundedProviderEvidence('test.allocator', undefined, 'the allocation ended');

    expect(evidence.code).toBeUndefined();
    expect('code' in evidence).toBe(false);
  });

  it('clamps an over-long summary instead of rejecting it', () => {
    const evidence = boundedProviderEvidence(
      'test.allocator',
      undefined,
      'x'.repeat(RECOVERY_EVIDENCE_LIMITS.summary * 2),
    );

    expect(evidence.summary).toHaveLength(RECOVERY_EVIDENCE_LIMITS.summary);
    expect(evidence.summary.endsWith('…')).toBe(true);
  });

  it('does not split a surrogate pair at the clamp boundary', () => {
    const prefix = 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.summary - 2);
    const evidence = boundedProviderEvidence('test.allocator', undefined, `${prefix}😀trailing`);

    expect(evidence.summary).toBe(`${prefix}…`);
    expect(evidence.summary).not.toContain('\ud83d');
  });

  it('leaves a summary at exactly the bound untouched', () => {
    const summary = 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.summary);

    expect(boundedProviderEvidence('test.allocator', undefined, summary).summary).toBe(summary);
  });

  it('reports an over-long source rather than silently reshaping it', () => {
    expect(() =>
      boundedProviderEvidence('x'.repeat(RECOVERY_EVIDENCE_LIMITS.source + 1), undefined, 'observed'),
    ).toThrow();
  });
});

describe('OutcomeAckDecision', () => {
  it('accepts all four ACK decisions', () => {
    for (const decision of ['accepted', 'duplicate', 'conflict', 'fenced'] as const) {
      expect(OutcomeAckDecisionSchema.parse(decision)).toBe(decision);
    }
  });

  it('rejects unknown decisions', () => {
    expect(() => OutcomeAckDecisionSchema.parse('rejected')).toThrow();
    expect(() => OutcomeAckDecisionSchema.parse('retry')).toThrow();
  });

  it('has a union type matching the four decisions', () => {
    expectTypeOf<OutcomeAckDecision>().toEqualTypeOf<'accepted' | 'duplicate' | 'conflict' | 'fenced'>();
  });
});

describe('WorkerMaterializationSpec', () => {
  it('validates local-directory materialization', () => {
    const spec: WorkerMaterializationSpec = {
      kind: 'local-directory',
      workspaceId: 'ws-1',
      rootDigest: 'sha256:abc123',
      sourcePath: 'src/workflow.ts',
    };

    const parsed = WorkerMaterializationSpecSchema.parse(spec);
    expect(parsed).toEqual(spec);
  });

  it('validates workspace-snapshot materialization', () => {
    const spec: WorkerMaterializationSpec = {
      kind: 'workspace-snapshot',
      snapshotId: 'snap-1',
      digest: 'sha256:def456',
      sourcePath: 'src/main',
    };

    const parsed = WorkerMaterializationSpecSchema.parse(spec);
    expect(parsed).toEqual(spec);
  });

  it('rejects unknown materialization kinds', () => {
    expect(() =>
      WorkerMaterializationSpecSchema.parse({
        kind: 'docker-image',
        image: 'node:22',
      }),
    ).toThrow();
  });

  it('rejects local-directory with missing fields', () => {
    expect(() =>
      LocalDirectoryMaterializationSchema.parse({
        kind: 'local-directory',
        workspaceId: 'ws-1',
      }),
    ).toThrow();
  });

  it('rejects workspace-snapshot with missing fields', () => {
    expect(() =>
      WorkspaceSnapshotMaterializationSchema.parse({
        kind: 'workspace-snapshot',
        snapshotId: 'snap-1',
      }),
    ).toThrow();
  });

  it('rejects unknown fields on local-directory (strict)', () => {
    expect(() =>
      LocalDirectoryMaterializationSchema.parse({
        kind: 'local-directory',
        workspaceId: 'ws-1',
        rootDigest: 'sha256:abc',
        sourcePath: 'src/main.ts',
        extraField: 'should-fail',
      }),
    ).toThrow();
  });

  it('rejects unknown fields on workspace-snapshot (strict)', () => {
    expect(() =>
      WorkspaceSnapshotMaterializationSchema.parse({
        kind: 'workspace-snapshot',
        snapshotId: 'snap-1',
        digest: 'sha256:abc',
        sourcePath: 'src',
        extraField: 'should-fail',
      }),
    ).toThrow();
  });

  it('has exactly two discriminants', () => {
    expectTypeOf<WorkerMaterializationSpec['kind']>().toEqualTypeOf<'local-directory' | 'workspace-snapshot'>();
  });
});

describe('WorkerContributionRef', () => {
  it('validates a complete contribution reference', () => {
    const ref: WorkerContributionRef = {
      packageName: '@acme/workflow-tools',
      version: '1.2.3',
      entrypoint: 'dist/server.mjs',
      integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
    };

    const parsed = WorkerContributionRefSchema.parse(ref);
    expect(parsed).toEqual(ref);
  });

  it('rejects empty packageName', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow();
  });

  it('rejects empty version', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '',
        entrypoint: 'dist/server.mjs',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow();
  });

  it('rejects empty entrypoint', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: '',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow();
  });

  it('rejects empty integrity', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: '',
      }),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
        nodeModulesPath: 'node_modules/@acme/tools',
      }),
    ).toThrow();
  });

  it('has the exact shape with four required string fields', () => {
    expectTypeOf<WorkerContributionRef>().toEqualTypeOf<{
      packageName: string;
      version: string;
      entrypoint: string;
      integrity: string;
    }>();
  });
});

describe('WorkerNodeAllocationLifetime', () => {
  it('exports the constant array of the two lifetimes', () => {
    expect(WORKER_NODE_ALLOCATION_LIFETIMES).toEqual(['provisioner-process-bound', 'provider-managed']);
  });

  it('validates both lifetimes', () => {
    expect(WorkerNodeAllocationLifetimeSchema.parse('provisioner-process-bound')).toBe('provisioner-process-bound');
    expect(WorkerNodeAllocationLifetimeSchema.parse('provider-managed')).toBe('provider-managed');
  });

  it('rejects unknown lifetimes', () => {
    expect(() => WorkerNodeAllocationLifetimeSchema.parse('ephemeral')).toThrow();
    expect(() => WorkerNodeAllocationLifetimeSchema.parse('')).toThrow();
  });

  it('has a type equal to the two-member union', () => {
    expectTypeOf<WorkerNodeAllocationLifetime>().toEqualTypeOf<'provisioner-process-bound' | 'provider-managed'>();
  });

  it('is a direct provider property with no default', () => {
    expectTypeOf<IWorkerNodeProvider>().toHaveProperty('allocationLifetime');
    expectTypeOf<IWorkerNodeProvider['allocationLifetime']>().toEqualTypeOf<WorkerNodeAllocationLifetime>();
  });

  it('is not placement capability, requirement, or inspection data', () => {
    expectTypeOf<WorkerNodeCapabilities>().not.toHaveProperty('allocationLifetime');
    expectTypeOf<WorkerNodeRequirements>().not.toHaveProperty('allocationLifetime');
    expectTypeOf<AllocationInspection>().not.toHaveProperty('allocationLifetime');
    expect(WorkerNodeCapabilitiesSchema.parse({ persistentStorage: false })).not.toHaveProperty('allocationLifetime');
  });
});

describe('BoundedRecoveryEvidence', () => {
  it('validates minimal bounded evidence', () => {
    const parsed = BoundedRecoveryEvidenceSchema.parse(EVIDENCE);
    expect(parsed).toEqual(EVIDENCE);
  });

  it('accepts an optional stable provider classification code', () => {
    const parsed = BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, code: 'invalid-workflow-file' });
    expect(parsed.code).toBe('invalid-workflow-file');
  });

  it('accepts an offset ISO timestamp', () => {
    const parsed = BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, observedAt: '2026-07-23T12:00:00+02:00' });
    expect(parsed.observedAt).toBe('2026-07-23T12:00:00+02:00');
  });

  it('accepts the millisecond precision produced by Date.toISOString', () => {
    const parsed = BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, observedAt: '2026-07-27T10:30:00.000Z' });
    expect(parsed.observedAt).toBe('2026-07-27T10:30:00.000Z');
    // The form every provider actually emits must stay valid.
    expect(() =>
      BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, observedAt: new Date().toISOString() }),
    ).not.toThrow();
  });

  it('rejects an overlong timestamp', () => {
    // ISO 8601 allows an unbounded fractional-second component, so without an
    // explicit length bound this shape would not be bounded at all.
    const overlong = `2026-07-27T10:30:00.${'0'.repeat(RECOVERY_EVIDENCE_LIMITS.observedAt)}Z`;
    expect(overlong.length).toBeGreaterThan(RECOVERY_EVIDENCE_LIMITS.observedAt);
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, observedAt: overlong })).toThrow();
  });

  it('rejects overlong fields', () => {
    expect(() =>
      BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, summary: 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.summary + 1) }),
    ).toThrow();
    expect(() =>
      BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, source: 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.source + 1) }),
    ).toThrow();
    expect(() =>
      BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, code: 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.code + 1) }),
    ).toThrow();
  });

  it('accepts fields at exactly the bound', () => {
    const parsed = BoundedRecoveryEvidenceSchema.parse({
      ...EVIDENCE,
      summary: 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.summary),
    });
    expect(parsed.summary).toHaveLength(RECOVERY_EVIDENCE_LIMITS.summary);
  });

  it('rejects empty fields', () => {
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, summary: '' })).toThrow();
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, source: '' })).toThrow();
  });

  it('rejects invalid ISO timestamps', () => {
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, observedAt: 'yesterday' })).toThrow();
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, observedAt: '2026-07-23' })).toThrow();
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, observedAt: '2026-13-01T10:00:00Z' })).toThrow();
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, observedAt: Date.now() })).toThrow();
  });

  it('rejects unbounded diagnostic payloads as extra fields', () => {
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, stack: 'Error: boom\n at x' })).toThrow();
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, providerResponse: { body: 'raw' } })).toThrow();
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, credentials: 'token' })).toThrow();
    expect(() => BoundedRecoveryEvidenceSchema.parse({ ...EVIDENCE, errors: [new Error('boom')] })).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => BoundedRecoveryEvidenceSchema.parse({ source: 'fly.machines' })).toThrow();
    expect(() =>
      BoundedRecoveryEvidenceSchema.parse({ source: 'fly.machines', summary: 'gone', observedAt: undefined }),
    ).toThrow();
  });

  it('is JSON-serializable', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(EVIDENCE));
    expect(BoundedRecoveryEvidenceSchema.parse(roundTripped)).toEqual(EVIDENCE);
  });
});

describe('WorkerNodeProvisionOutcome', () => {
  it('carries the allocation reference and handle when allocated', () => {
    const outcome: WorkerNodeProvisionOutcome = {
      kind: 'allocated',
      allocationRef: {
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'piscina',
        providerData: { threadId: 42 },
      },
      handle: {
        executionAttemptId: 'attempt-1',
        cancel: async () => {},
        terminate: async () => {},
        release: async () => {},
      },
    };

    if (outcome.kind !== 'allocated') throw new Error('expected an allocated outcome');
    expect(outcome.allocationRef.providerId).toBe('piscina');
    expect(outcome.handle.executionAttemptId).toBe('attempt-1');
  });

  it('carries only bounded evidence when confirmed absent', () => {
    const outcome: WorkerNodeProvisionOutcome = { kind: 'confirmed-absent', evidence: EVIDENCE };

    if (outcome.kind !== 'confirmed-absent') throw new Error('expected a confirmed-absent outcome');
    expect(outcome.evidence).toEqual(EVIDENCE);
    expectTypeOf(outcome).not.toHaveProperty('allocationRef');
    expectTypeOf(outcome).not.toHaveProperty('handle');
  });

  it('has exactly two discriminants', () => {
    expectTypeOf<WorkerNodeProvisionOutcome['kind']>().toEqualTypeOf<'allocated' | 'confirmed-absent'>();
  });

  it('is the provision return type', () => {
    expectTypeOf<Awaited<ReturnType<IWorkerNodeProvider['provision']>>>().toEqualTypeOf<WorkerNodeProvisionOutcome>();
  });
});

describe('ProvisioningDiscovery', () => {
  it('exports the three discovery kinds', () => {
    expect(PROVISIONING_DISCOVERY_KINDS).toEqual(['found', 'confirmed-absent', 'unknown']);
    expectTypeOf<ProvisioningDiscovery['kind']>().toEqualTypeOf<'found' | 'confirmed-absent' | 'unknown'>();
  });

  it('validates a found allocation', () => {
    const discovery: ProvisioningDiscovery = {
      kind: 'found',
      allocationRef: {
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'github-actions',
        providerData: { runId: 12345 },
      },
    };

    expect(ProvisioningDiscoverySchema.parse(discovery)).toEqual(discovery);
  });

  it('validates confirmed absence with bounded evidence', () => {
    const discovery: ProvisioningDiscovery = { kind: 'confirmed-absent', evidence: EVIDENCE };
    expect(ProvisioningDiscoverySchema.parse(discovery)).toEqual(discovery);
  });

  it('validates retained uncertainty with bounded evidence', () => {
    const discovery: ProvisioningDiscovery = { kind: 'unknown', evidence: EVIDENCE };
    expect(ProvisioningDiscoverySchema.parse(discovery)).toEqual(discovery);
  });

  it('rejects unknown discovery kinds', () => {
    expect(() => ProvisioningDiscoverySchema.parse({ kind: 'absent', evidence: EVIDENCE })).toThrow();
    expect(() => ProvisioningDiscoverySchema.parse({ kind: 'maybe', evidence: EVIDENCE })).toThrow();
  });

  it('rejects a found result without a valid allocation reference', () => {
    expect(() => ProvisioningDiscoverySchema.parse({ kind: 'found' })).toThrow();
    expect(() =>
      ProvisioningDiscoverySchema.parse({
        kind: 'found',
        allocationRef: { version: 99, providerId: 'fly', providerData: {} },
      }),
    ).toThrow();
  });

  it('rejects absence or uncertainty without bounded evidence', () => {
    expect(() => ProvisioningDiscoverySchema.parse({ kind: 'confirmed-absent' })).toThrow();
    expect(() => ProvisioningDiscoverySchema.parse({ kind: 'unknown' })).toThrow();
    expect(() =>
      ProvisioningDiscoverySchema.parse({ kind: 'unknown', evidence: { ...EVIDENCE, observedAt: 'not-a-date' } }),
    ).toThrow();
  });

  it('rejects unknown fields on every member (strict)', () => {
    expect(() =>
      ProvisioningDiscoverySchema.parse({
        kind: 'found',
        allocationRef: {
          version: PROVIDER_ALLOCATION_REF_VERSION,
          providerId: 'fly',
          providerData: {},
        },
        evidence: EVIDENCE,
      }),
    ).toThrow();
    expect(() =>
      ProvisioningDiscoverySchema.parse({ kind: 'confirmed-absent', evidence: EVIDENCE, rawResponse: {} }),
    ).toThrow();
    expect(() => ProvisioningDiscoverySchema.parse({ kind: 'unknown', evidence: EVIDENCE, stack: 'boom' })).toThrow();
  });

  it('never carries a handle — discovery is side-effect-free', () => {
    expectTypeOf<Extract<ProvisioningDiscovery, { kind: 'found' }>>().not.toHaveProperty('handle');
  });

  it('is JSON-serializable', () => {
    const discovery: ProvisioningDiscovery = { kind: 'unknown', evidence: EVIDENCE };
    const roundTripped: unknown = JSON.parse(JSON.stringify(discovery));
    expect(ProvisioningDiscoverySchema.parse(roundTripped)).toEqual(discovery);
  });
});

// ─────────────────────────────────────────────────────────────
// Plan 2 — Provider Recovery Capability
// ─────────────────────────────────────────────────────────────

describe('AllocationState', () => {
  it('defines exactly seven allocation states', () => {
    const expected: AllocationState[] = [
      'unknown',
      'provisioning',
      'ready',
      'running',
      'suspended',
      'terminal',
      'absent',
    ];

    for (const state of expected) {
      expect(AllocationStateSchema.parse(state)).toBe(state);
    }
  });

  it('rejects unknown states', () => {
    expect(() => AllocationStateSchema.parse('starting')).toThrow();
    expect(() => AllocationStateSchema.parse('paused')).toThrow();
    expect(() => AllocationStateSchema.parse('')).toThrow();
  });

  it('exports a constant array of all states', () => {
    expect(ALLOCATION_STATES).toEqual([
      'unknown',
      'provisioning',
      'ready',
      'running',
      'suspended',
      'terminal',
      'absent',
    ]);
  });

  it('has a type equal to the seven-member union', () => {
    expectTypeOf<AllocationState>().toEqualTypeOf<
      'unknown' | 'provisioning' | 'ready' | 'running' | 'suspended' | 'terminal' | 'absent'
    >();
  });
});

describe('AllocationInspection', () => {
  it('validates a minimal inspection result', () => {
    const inspection: AllocationInspection = {
      state: 'running',
      allocationRef: {
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'fly.machines',
        providerData: { machineId: 'machine-1' },
      },
    };

    const parsed = AllocationInspectionSchema.parse(inspection);
    expect(parsed.state).toBe('running');
    expect(parsed.allocationRef.providerId).toBe('fly.machines');
  });

  it('validates an inspection with provider evidence', () => {
    const inspection: AllocationInspection = {
      state: 'terminal',
      allocationRef: {
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'github-actions',
        providerData: { runId: 12345, jobName: 'workflow-worker' },
      },
      evidence: {
        exitCode: 1,
        terminatedAt: '2026-07-23T10:00:00Z',
        reason: 'OOM killed',
      },
    };

    const parsed = AllocationInspectionSchema.parse(inspection);
    expect(parsed.state).toBe('terminal');
    expect(parsed.evidence).toEqual({
      exitCode: 1,
      terminatedAt: '2026-07-23T10:00:00Z',
      reason: 'OOM killed',
    });
  });

  it('validates an absent allocation', () => {
    const inspection: AllocationInspection = {
      state: 'absent',
      allocationRef: {
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'fly.machines',
        providerData: { machineId: 'gone-machine' },
      },
    };

    const parsed = AllocationInspectionSchema.parse(inspection);
    expect(parsed.state).toBe('absent');
    expect(parsed.evidence).toBeUndefined();
  });

  it('rejects invalid allocation state', () => {
    expect(() =>
      AllocationInspectionSchema.parse({
        state: 'invalid',
        allocationRef: {
          version: PROVIDER_ALLOCATION_REF_VERSION,
          providerId: 'fly',
          providerData: {},
        },
      }),
    ).toThrow();
  });

  it('rejects invalid allocation ref', () => {
    expect(() =>
      AllocationInspectionSchema.parse({
        state: 'running',
        allocationRef: {
          version: 99,
          providerId: 'fly',
          providerData: {},
        },
      }),
    ).toThrow();
  });

  it('is JSON-serializable', () => {
    const inspection: AllocationInspection = {
      state: 'running',
      allocationRef: {
        version: PROVIDER_ALLOCATION_REF_VERSION,
        providerId: 'fly.machines',
        providerData: { machineId: 'm-1', region: 'iad' },
      },
      evidence: { startedAt: '2026-07-23T09:00:00Z' },
    };

    const roundTripped = JSON.parse(JSON.stringify(inspection));
    expect(AllocationInspectionSchema.parse(roundTripped)).toEqual(inspection);
  });
});

describe('IWorkerNodeRecoveryCapability', () => {
  it('requires discovery, attach, inspect, and terminateAllocation together', () => {
    // Compile-time proof: all four methods are required on the interface
    expectTypeOf<IWorkerNodeRecoveryCapability>().toHaveProperty('discoverProvisioning');
    expectTypeOf<IWorkerNodeRecoveryCapability>().toHaveProperty('attach');
    expectTypeOf<IWorkerNodeRecoveryCapability>().toHaveProperty('inspect');
    expectTypeOf<IWorkerNodeRecoveryCapability>().toHaveProperty('terminateAllocation');
  });

  it('rejects partial recovery capabilities', () => {
    // Each of these omits exactly one member of the coherent capability and
    // must therefore not satisfy the interface.
    expectTypeOf<
      Omit<IWorkerNodeRecoveryCapability, 'discoverProvisioning'>
    >().not.toMatchTypeOf<IWorkerNodeRecoveryCapability>();
    expectTypeOf<Omit<IWorkerNodeRecoveryCapability, 'attach'>>().not.toMatchTypeOf<IWorkerNodeRecoveryCapability>();
    expectTypeOf<Omit<IWorkerNodeRecoveryCapability, 'inspect'>>().not.toMatchTypeOf<IWorkerNodeRecoveryCapability>();
    expectTypeOf<
      Omit<IWorkerNodeRecoveryCapability, 'terminateAllocation'>
    >().not.toMatchTypeOf<IWorkerNodeRecoveryCapability>();
  });

  it('discoverProvisioning takes the provision request and a signal', () => {
    expectTypeOf<IWorkerNodeRecoveryCapability['discoverProvisioning']>().parameters.toEqualTypeOf<
      [WorkerNodeProvisionRequest, AbortSignal]
    >();
  });

  it('discoverProvisioning returns a ProvisioningDiscovery', () => {
    expectTypeOf<
      Awaited<ReturnType<IWorkerNodeRecoveryCapability['discoverProvisioning']>>
    >().toEqualTypeOf<ProvisioningDiscovery>();
  });

  it('attach returns a fresh WorkerNodeHandle', () => {
    expectTypeOf<Awaited<ReturnType<IWorkerNodeRecoveryCapability['attach']>>>().toEqualTypeOf<WorkerNodeHandle>();
  });

  it('inspect returns an AllocationInspection', () => {
    expectTypeOf<Awaited<ReturnType<IWorkerNodeRecoveryCapability['inspect']>>>().toEqualTypeOf<AllocationInspection>();
  });

  it('terminateAllocation returns void', () => {
    expectTypeOf<Awaited<ReturnType<IWorkerNodeRecoveryCapability['terminateAllocation']>>>().toEqualTypeOf<void>();
  });

  it('attach takes allocationRef, request, and signal', () => {
    expectTypeOf<IWorkerNodeRecoveryCapability['attach']>().parameters.toEqualTypeOf<
      [ProviderAllocationRef, WorkerNodeProvisionRequest, AbortSignal]
    >();
  });

  it('inspect takes allocationRef, request, and signal', () => {
    expectTypeOf<IWorkerNodeRecoveryCapability['inspect']>().parameters.toEqualTypeOf<
      [ProviderAllocationRef, WorkerNodeProvisionRequest, AbortSignal]
    >();
  });

  it('terminateAllocation takes ref, request, and signal', () => {
    expectTypeOf<IWorkerNodeRecoveryCapability['terminateAllocation']>().parameters.toEqualTypeOf<
      [ProviderAllocationRef, WorkerNodeProvisionRequest, AbortSignal]
    >();
  });

  it('can be implemented as a concrete object', () => {
    const recovery: IWorkerNodeRecoveryCapability = {
      discoverProvisioning: async (_request, _signal) => ({ kind: 'unknown' as const, evidence: EVIDENCE }),
      attach: async (_ref, _request, _signal) => ({
        executionAttemptId: 'attempt-1',
        cancel: async () => {},
        terminate: async () => {},
        release: async () => {},
      }),
      inspect: async (_ref, _request, _signal) => ({
        state: 'running' as const,
        allocationRef: {
          version: PROVIDER_ALLOCATION_REF_VERSION,
          providerId: 'fly.machines',
          providerData: { machineId: 'm-1' },
        },
      }),
      terminateAllocation: async (_ref, _request, _signal) => {},
    };

    expect(recovery.discoverProvisioning).toBeDefined();
    expect(recovery.attach).toBeDefined();
    expect(recovery.inspect).toBeDefined();
    expect(recovery.terminateAllocation).toBeDefined();
  });
});

describe('IRecoverableWorkerNodeProvider', () => {
  it('extends IWorkerNodeProvider with a required recovery property', () => {
    const provider: IRecoverableWorkerNodeProvider = {
      id: 'fly.machines',
      displayName: 'Fly Machines',
      environment: 'fly',
      allocationLifetime: 'provider-managed',
      baseCapabilities: WorkerNodeCapabilitiesSchema.parse({
        persistentStorage: true,
        supportsRecovery: true,
      }),
      provision: async () => ({
        kind: 'allocated' as const,
        allocationRef: {
          version: PROVIDER_ALLOCATION_REF_VERSION,
          providerId: 'fly.machines',
          providerData: { machineId: 'm-1' },
        },
        handle: {
          executionAttemptId: 'attempt-1',
          cancel: async () => {},
          terminate: async () => {},
          release: async () => {},
        },
      }),
      recovery: {
        discoverProvisioning: async (_request, _signal) => ({ kind: 'unknown' as const, evidence: EVIDENCE }),
        attach: async (_ref, _request, _signal) => ({
          executionAttemptId: 'attempt-1',
          cancel: async () => {},
          terminate: async () => {},
          release: async () => {},
        }),
        inspect: async (_ref, _request, _signal) => ({
          state: 'running' as const,
          allocationRef: {
            version: PROVIDER_ALLOCATION_REF_VERSION,
            providerId: 'fly.machines',
            providerData: { machineId: 'm-1' },
          },
        }),
        terminateAllocation: async (_ref, _request, _signal) => {},
      },
    };

    expect(provider.recovery).toBeDefined();
    expect(provider.recovery.discoverProvisioning).toBeDefined();
    expect(provider.recovery.attach).toBeDefined();
    expect(provider.recovery.inspect).toBeDefined();
    expect(provider.recovery.terminateAllocation).toBeDefined();
  });

  it('is assignable to IWorkerNodeProvider', () => {
    expectTypeOf<IRecoverableWorkerNodeProvider>().toMatchTypeOf<IWorkerNodeProvider>();
  });

  it('has recovery as a required property, not optional', () => {
    // This verifies that IRecoverableWorkerNodeProvider.recovery is not optional.
    // If recovery were optional, this type assertion would be
    // IWorkerNodeRecoveryCapability | undefined.
    expectTypeOf<IRecoverableWorkerNodeProvider['recovery']>().toEqualTypeOf<IWorkerNodeRecoveryCapability>();
  });
});

describe('non-recoverable provider shape', () => {
  it('IWorkerNodeProvider does not require recovery', () => {
    // A plain IWorkerNodeProvider without recovery must compile
    const provider: IWorkerNodeProvider = {
      id: 'piscina',
      displayName: 'Piscina Local',
      environment: 'piscina',
      allocationLifetime: 'provisioner-process-bound',
      baseCapabilities: WorkerNodeCapabilitiesSchema.parse({
        persistentStorage: false,
      }),
      provision: async () => ({
        kind: 'allocated' as const,
        allocationRef: {
          version: PROVIDER_ALLOCATION_REF_VERSION,
          providerId: 'piscina',
          providerData: {},
        },
        handle: {
          executionAttemptId: 'attempt-1',
          cancel: async () => {},
          terminate: async () => {},
          release: async () => {},
        },
      }),
    };

    expect(provider.id).toBe('piscina');
    expect(provider.baseCapabilities.supportsRecovery).toBe(false);
  });
});

describe('WorkerNodeCapabilities recovery advertisement', () => {
  it('defaults supportsRecovery to false', () => {
    const parsed = WorkerNodeCapabilitiesSchema.parse({
      persistentStorage: false,
    });

    expect(parsed.supportsRecovery).toBe(false);
  });

  it('accepts explicit supportsRecovery true', () => {
    const parsed = WorkerNodeCapabilitiesSchema.parse({
      persistentStorage: true,
      supportsRecovery: true,
    });

    expect(parsed.supportsRecovery).toBe(true);
  });

  it('accepts explicit supportsRecovery false', () => {
    const parsed = WorkerNodeCapabilitiesSchema.parse({
      persistentStorage: false,
      supportsRecovery: false,
    });

    expect(parsed.supportsRecovery).toBe(false);
  });
});

describe('WorkerNodeRequirements recovery field', () => {
  it('allows omitting recoverableAllocation', () => {
    const requirements: WorkerNodeRequirements = {
      persistentStorage: true,
    };

    const parsed = WorkerNodeRequirementsSchema.parse(requirements);
    expect(parsed.recoverableAllocation).toBeUndefined();
  });

  it('accepts recoverableAllocation true', () => {
    const requirements: WorkerNodeRequirements = {
      recoverableAllocation: true,
    };

    const parsed = WorkerNodeRequirementsSchema.parse(requirements);
    expect(parsed.recoverableAllocation).toBe(true);
  });

  it('accepts recoverableAllocation false', () => {
    const requirements: WorkerNodeRequirements = {
      recoverableAllocation: false,
    };

    const parsed = WorkerNodeRequirementsSchema.parse(requirements);
    expect(parsed.recoverableAllocation).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Plan 3 — Materialization Modes
// ─────────────────────────────────────────────────────────────

describe('MaterializationMode', () => {
  it('exports the constant array of supported modes', () => {
    expect(MATERIALIZATION_MODES).toEqual(['local-directory', 'workspace-snapshot']);
  });

  it('validates known materialization modes', () => {
    expect(MaterializationModeSchema.parse('local-directory')).toBe('local-directory');
    expect(MaterializationModeSchema.parse('workspace-snapshot')).toBe('workspace-snapshot');
  });

  it('rejects unknown materialization modes', () => {
    expect(() => MaterializationModeSchema.parse('docker-image')).toThrow();
  });
});

describe('WorkerNodeCapabilities materialization modes', () => {
  it('defaults materializationModes to local-directory', () => {
    const parsed = WorkerNodeCapabilitiesSchema.parse({
      persistentStorage: false,
    });

    expect(parsed.materializationModes).toEqual(['local-directory']);
  });

  it('accepts explicit materialization modes', () => {
    const parsed = WorkerNodeCapabilitiesSchema.parse({
      persistentStorage: true,
      materializationModes: ['workspace-snapshot'],
    });

    expect(parsed.materializationModes).toEqual(['workspace-snapshot']);
  });

  it('accepts multiple materialization modes', () => {
    const parsed = WorkerNodeCapabilitiesSchema.parse({
      persistentStorage: true,
      materializationModes: ['local-directory', 'workspace-snapshot'],
    });

    expect(parsed.materializationModes).toEqual(['local-directory', 'workspace-snapshot']);
  });

  it('rejects empty materialization modes array', () => {
    expect(() =>
      WorkerNodeCapabilitiesSchema.parse({
        persistentStorage: false,
        materializationModes: [],
      }),
    ).toThrow();
  });

  it('rejects unknown materialization mode values', () => {
    expect(() =>
      WorkerNodeCapabilitiesSchema.parse({
        persistentStorage: false,
        materializationModes: ['docker-image'],
      }),
    ).toThrow();
  });
});

describe('WorkerNodeRequirements materialization modes', () => {
  it('allows omitting materializationModes', () => {
    const parsed = WorkerNodeRequirementsSchema.parse({
      persistentStorage: true,
    });

    expect(parsed.materializationModes).toBeUndefined();
  });

  it('accepts materialization mode requirements', () => {
    const parsed = WorkerNodeRequirementsSchema.parse({
      materializationModes: ['workspace-snapshot'],
    });

    expect(parsed.materializationModes).toEqual(['workspace-snapshot']);
  });

  it('rejects unknown materialization mode in requirements', () => {
    expect(() =>
      WorkerNodeRequirementsSchema.parse({
        materializationModes: ['s3-bucket'],
      }),
    ).toThrow();
  });
});

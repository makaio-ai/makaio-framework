import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { WorkerContributionManifest, WorkerProvisionRequest, WorkflowWorkerConfig } from '@makaio/contracts';
import { PROVIDER_ALLOCATION_REF_VERSION, WorkerNamespace, WorkerSubjects } from '@makaio/contracts';
import type {
  BeginProvisioningInput,
  ExecutionAttemptRepository,
  ProviderOperationClaim,
  WorkflowAttemptOutcome,
} from '@makaio/subsystem-workflow-engine';
import { buildWorkflowAttemptInstruction, workflowAttemptOutcomeCodec } from '@makaio/subsystem-workflow-engine';
import {
  beginTestProvisioning,
  leaseAt,
  makeProcessLossProof,
  makeTestInstruction,
  TEST_PROVISIONER_INCARNATION_ID,
} from '@makaio/subsystem-workflow-engine/testing';
import { createSqliteAttemptRepository } from '@makaio/subsystem-workflow-engine/testing/sqlite';
import { createRestartableTempDb } from '@makaio/test-utils/drizzle-harness';
import { PiscinaThinWorkflowProvider } from '../piscina-thin-workflow-provider.js';
import { ThinWorkflowPiscinaRunner } from '../thin-workflow-piscina-runner.js';
import { createWorkflowLaunchResolver } from '../workflow-launch-resolver.js';
import { WORKFLOW_WORKER_READY_MESSAGE_TYPE } from '../worker-ready-message.js';
import { computeContributionPackageDigest, computeDirectoryDigest } from '../local-directory-materializer.js';
import { makeWorkerConfig } from './fixtures.js';

let tempDir: string | undefined;

/**
 * Bus URL every provisioned worker configuration below carries.
 *
 * The provider refuses to provision a thread with no transport, because such a
 * thread can never authenticate as its attempt. The echo worker entries used
 * here never dial it, so the value only has to exist.
 */
const PROVISION_BUS_URL = 'ws://127.0.0.1:65535/bus';

/**
 * Workflow config that can be frozen without a host-side definition snapshot.
 * @param overrides - Fields that specialize the portable workflow configuration.
 */
function makeProvisionableWorkflowConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return makeWorkerConfig({
    source: { kind: 'source', filename: 'workflows/example.ts', source: 'export default {};' },
    ...overrides,
  });
}

/**
 * Build the generic provider request paired with a canonical workflow instruction.
 * The test intentionally crosses the same adapter boundary production uses.
 * @param config - Workflow semantics serialized into the canonical instruction.
 * @param executionAttemptId - Authority-created Attempt identifier.
 * @param manifest - Runtime-selected contribution manifest.
 */
function createWorkflowProvisionRequest(
  config: WorkflowWorkerConfig,
  executionAttemptId: string,
  manifest: WorkerContributionManifest = { contributionRefs: [] },
): WorkerProvisionRequest {
  return {
    executionId: config.executionId,
    executionAttemptId,
    bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
    environment: 'piscina',
    runtimeInputs: {
      workerManifest: manifest,
      suspensionStrategy: config.suspensionStrategy,
    },
    connection: {
      ...(config.busUrl !== undefined ? { busUrl: config.busUrl } : {}),
      busAuth: config.busAuth,
      ...(Object.keys(config.env).length > 0 ? { env: config.env } : {}),
    },
    provisioningStartedAt: new Date().toISOString(),
  };
}

/**
 * Build a real workflow adapter for one canonical test configuration.
 * @param config - Workflow semantics frozen for the provider fixture.
 */
function createWorkflowLaunchResolverForConfig(config: WorkflowWorkerConfig) {
  const instruction = buildWorkflowAttemptInstruction({
    id: `instruction-${config.executionId}`,
    revision: '1',
    config,
    preservation: { required: [] },
  });
  return createWorkflowLaunchResolver(async ({ executionId }) =>
    executionId === config.executionId ? instruction : null,
  );
}

/**
 * Remove the temporary directory the current test created, if any.
 * @returns Promise that resolves once the directory is gone.
 */
async function removeTempDir(): Promise<void> {
  if (tempDir === undefined) return;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
}

/**
 * Create a temporary Piscina worker entry that echoes workflow task fields.
 *
 * An attempt-bound task first posts the ready message the shipped entry posts
 * once the Authority accepted its runtime. No Authority exists in these tests,
 * so the stub asserts what the entry would have proven; without it the
 * provider treats the run as refused before admission and never submits its
 * result as an outcome. The short pause lets the message reach the pool ahead
 * of the task's own return, which travels on a different port.
 * @returns Absolute path to the worker entry module.
 */
async function createEchoWorkerEntry(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'thin-workflow-piscina-runner-'));
  const workerEntry = join(tempDir, 'worker-entry.mjs');
  await writeFile(
    workerEntry,
    [
      "import { parentPort } from 'node:worker_threads';",
      'export default async function run(task) {',
      "  if (task.kind === 'attempt-bound') {",
      '    const acknowledged = new Promise((resolve) => task.bootstrapPort.once("message", resolve));',
      '    task.bootstrapPort.postMessage("takeover");',
      '    if (await acknowledged !== "acknowledged") throw new Error("Invalid handoff");',
      '    task.bootstrapPort.close();',
      '    parentPort?.postMessage({',
      `      type: '${WORKFLOW_WORKER_READY_MESSAGE_TYPE}',`,
      '      executionId: task.config.executionId,',
      '      cancelSubject: task.config.cancelSubject,',
      '      executionAttemptId: task.executionAttemptId,',
      '    });',
      '    await new Promise((resolve) => setTimeout(resolve, 20));',
      '  }',
      '  return {',
      '    executionId: task.config.executionId,',
      '    workflowId: task.config.workflowId,',
      "    status: 'completed',",
      '  };',
      '}',
    ].join('\n'),
  );
  return workerEntry;
}

/**
 * Create a local workspace with a workflow source and a verified extension
 * package. The worker entry returns its received task, proving the host
 * materialized it before Piscina imported the worker module.
 * @returns Workspace root, task-echo worker entry, and contribution manifest.
 */
async function createMaterializedWorkspace(): Promise<{
  readonly workspaceRoot: string;
  readonly workerEntry: string;
  readonly rootDigest: string;
  readonly manifest: WorkerContributionManifest;
}> {
  tempDir = await mkdtemp(join(tmpdir(), 'thin-workflow-piscina-materialization-'));
  const workspaceRoot = join(tempDir, 'external-workspace');
  const packageRoot = join(workspaceRoot, 'node_modules', 'example-worker-extension');
  await mkdir(join(workspaceRoot, 'workflows'), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'workflows', 'example.mjs'), 'export default {}\n');
  const contributionEntrypoint = join(packageRoot, 'worker.mjs');
  await writeFile(contributionEntrypoint, 'export default { name: "example-worker-extension", adapters: [] };\n');
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'example-worker-extension', version: '1.2.3', type: 'module' }),
  );
  const workerEntry = join(tempDir, 'worker-entry.mjs');
  await writeFile(
    workerEntry,
    [
      'export default async function run(task) {',
      '  return { executionId: task.config.executionId, workflowId: task.config.workflowId, status: "completed", task };',
      '}',
    ].join('\n'),
  );
  const integrity = await computeContributionPackageDigest(packageRoot, 'sha384');
  return {
    workspaceRoot,
    workerEntry,
    rootDigest: await computeDirectoryDigest(workspaceRoot),
    manifest: {
      contributionRefs: [
        {
          packageName: 'example-worker-extension',
          version: '1.2.3',
          entrypoint: 'worker.mjs',
          integrity,
        },
      ],
    },
  };
}

/** One provider service instance over its own real Piscina worker-thread pool. */
interface ProviderServiceInstance {
  /** Provider under test, backed by a real thin workflow runner. */
  readonly provider: PiscinaThinWorkflowProvider;
  /** Attempt identifier of the first outcome this service delivered durably. */
  readonly acknowledgedAttemptId: Promise<string>;
  /**
   * Tear this service down: unsubscribe its outcome handler and destroy its pool.
   * @returns Promise that resolves once the pool is gone.
   */
  dispose(): Promise<void>;
}

/**
 * Build one provider service over a real Piscina runner.
 *
 * The bus carries a real acknowledging outcome handler, so a provisioned run
 * settles on a resolved promise rather than on elapsed time.
 * @param workerEntry - Worker entry module every provisioned thread runs.
 * @param id - Identity of this service instance.
 * @returns The provider, its delivered-outcome signal, and its teardown.
 */
function createProviderService(workerEntry: string, id: string): ProviderServiceInstance {
  const runner = new ThinWorkflowPiscinaRunner({
    workerEntry,
    manifest: { contributionRefs: [] },
    maxConcurrency: 1,
    idleTimeoutMs: 100,
  });
  const bus = createBusInstance();
  bus.registerNamespace(WorkerNamespace);
  const acknowledged = Promise.withResolvers<string>();
  const offSubmit = bus.on(WorkerSubjects.control.outcome.submit, (ctx) => {
    ctx.setResult({ decision: 'accepted' });
    acknowledged.resolve(ctx.payload.executionAttemptId);
  });

  return {
    provider: new PiscinaThinWorkflowProvider({
      id,
      displayName: id,
      runner,
      bus,
      launchResolver: createWorkflowLaunchResolver(async ({ executionId }) =>
        buildWorkflowAttemptInstruction({
          id: `instruction-${executionId}`,
          revision: '1',
          config: makeProvisionableWorkflowConfig({
            executionId,
            busUrl: PROVISION_BUS_URL,
            cancelSubject: `workflow.${executionId}.cancel`,
          }),
          preservation: { required: [] },
        }),
      ),
    }),
    acknowledgedAttemptId: acknowledged.promise,
    dispose: async (): Promise<void> => {
      offSubmit();
      await runner.dispose();
    },
  };
}

/**
 * Begin provisioning for an attempt whose allocation lives inside a process.
 *
 * Every proof below binds the same allocation lifetime, and that binding is
 * what makes a process-loss proof applicable at all, so it is stated once here
 * instead of in each test. `beginTestProvisioning` fails loudly on any decision
 * other than `started`, so a caller holding a claim knows one was issued.
 *
 * The lifetime is omitted from the overrides rather than accepted and
 * discarded: a proof that binds a different lifetime is not the thing this
 * helper is named after, and saying so in the type is what keeps every claim it
 * hands out actually process-bound.
 * @param repository - Durable attempt repository the proof drives.
 * @param executionAttemptId - Attempt about to start provisioning.
 * @param executionId - Execution the attempt belongs to.
 * @param overrides - Identity and lease fields the individual proof varies.
 * @returns The claim the successful begin issued.
 */
async function beginProcessBoundProvisioning(
  repository: Required<ExecutionAttemptRepository<WorkflowAttemptOutcome>>,
  executionAttemptId: string,
  executionId: string,
  overrides: Omit<Partial<BeginProvisioningInput>, 'allocationLifetime'> = {},
): Promise<ProviderOperationClaim> {
  return beginTestProvisioning(repository, executionAttemptId, executionId, {
    ...overrides,
    allocationLifetime: 'provisioner-process-bound',
  });
}

describe('ThinWorkflowPiscinaRunner integration', () => {
  afterEach(removeTempDir);

  it('runs a real Piscina worker with an explicit empty contribution identity set', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry,
      manifest: { contributionRefs: [] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });
    const perCallManifest: WorkerContributionManifest = { contributionRefs: [] };

    try {
      const completion = await runner.run(makeWorkerConfig(), new AbortController().signal, perCallManifest);
      expect(completion).toMatchObject({
        state: 'uncommitted',
        result: {
          executionId: 'wfx-1',
          workflowId: 'workflow-1',
          status: 'completed',
        },
      });
    } finally {
      await runner.dispose();
    }
  });

  it('materializes an external local workspace and verified contribution before Piscina dispatch', async () => {
    const workspace = await createMaterializedWorkspace();
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry: workspace.workerEntry,
      manifest: workspace.manifest,
      resolveWorkspaceRoot: async (workspaceId) =>
        workspaceId === 'external-workspace' ? workspace.workspaceRoot : undefined,
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });
    const config = makeWorkerConfig({
      source: { kind: 'path', path: 'workflows/example.mjs' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'external-workspace',
        rootDigest: workspace.rootDigest,
        sourcePath: 'workflows/example.mjs',
      },
    });

    try {
      const completion = await runner.run(config, new AbortController().signal, workspace.manifest);
      if (completion.state !== 'uncommitted') throw new Error('Piscina leaves owner finalization to its caller');
      expect(completion.result).toMatchObject({
        status: 'completed',
        task: {
          config: { source: { kind: 'path', path: join(workspace.workspaceRoot, 'workflows', 'example.mjs') } },
          contributionEntrypoints: [
            join(workspace.workspaceRoot, 'node_modules', 'example-worker-extension', 'worker.mjs'),
          ],
        },
      });
    } finally {
      await runner.dispose();
    }
  });

  it('provisions through the provider with a real thin Piscina runner', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry,
      manifest: { contributionRefs: [] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-integration',
      displayName: 'Piscina Integration',
      runner,
      bus,
      launchResolver: createWorkflowLaunchResolverForConfig(
        makeProvisionableWorkflowConfig({ busUrl: PROVISION_BUS_URL }),
      ),
    });
    const perCallManifest: WorkerContributionManifest = { contributionRefs: [] };

    try {
      const outcome = await provider.provision(
        createWorkflowProvisionRequest(
          makeProvisionableWorkflowConfig({ busUrl: PROVISION_BUS_URL }),
          'attempt-integration',
          perCallManifest,
        ),
        new AbortController().signal,
      );
      if (outcome.kind !== 'allocated') throw new Error(`Expected allocation, got '${outcome.kind}'`);
      const { allocationRef, handle } = outcome;

      expect(allocationRef.version).toBe(PROVIDER_ALLOCATION_REF_VERSION);
      // The reference names the instance that created it, which is what binds
      // it to the attempt this provider was selected for.
      expect(allocationRef.providerId).toBe('piscina-integration');
      expect(allocationRef.providerData).toMatchObject({
        executionAttemptId: 'attempt-integration',
      });
      expect(handle.executionAttemptId).toBe('attempt-integration');
    } finally {
      await runner.dispose();
    }
  });

  it('does not create the Piscina pool before the first run', async () => {
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry: join(tmpdir(), 'missing-workflow-worker-entry.mjs'),
      manifest: { contributionRefs: [] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });

    await expect(runner.dispose()).resolves.toBeUndefined();
  });
});

/** Controller incarnation that takes an operation over from the first one. */
const SECOND_CONTROLLER_ID = 'controller-incarnation-2';

/** A provisioner incarnation that is not the one any attempt below is bound to. */
const FOREIGN_PROVISIONER_INCARNATION_ID = 'provisioner-incarnation-elsewhere';

/**
 * What a process-bound allocation lifetime costs, and what it therefore takes
 * to converge one.
 *
 * The provider allocates worker threads inside the process that provisioned
 * them, so there is nothing to attach to or rediscover afterwards. The only
 * durable transition that can close such an attempt without an outcome is
 * positive proof that the *process* is gone, and these four proofs pin the
 * boundary of that statement: what counts as proof, what does not, and why
 * nothing weaker is available as a fallback.
 *
 * The durable state is a real file-backed store, read and written through two
 * independent connections, so a fact only holds here once it has survived
 * leaving the connection that wrote it.
 *
 * Two of the proofs below submit a loss proof straight to the durable port
 * rather than through a remediation reducer: the reducer that decides when to
 * reach for one lives above this runtime and is not importable here. What it
 * covers — which obligation selects that closer, and what a rejected proof
 * leaves behind — is proven where that reducer lives; what is proven here is
 * the transition itself, which is the part this provider's lifetime depends on.
 */
describe('process-bound allocation lifetime', () => {
  const store = createRestartableTempDb('piscina-process-bound');
  let repositoryA: Required<ExecutionAttemptRepository<WorkflowAttemptOutcome>>;
  let repositoryB: Required<ExecutionAttemptRepository<WorkflowAttemptOutcome>>;

  beforeAll(async () => {
    repositoryA = await createSqliteAttemptRepository(await store.connect(), workflowAttemptOutcomeCodec);
    repositoryB = await createSqliteAttemptRepository(await store.connect(), workflowAttemptOutcomeCodec);
  });

  afterEach(removeTempDir);

  afterAll(async () => {
    await store.close();
  });

  it('advertises no attach or discovery capability', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const service = createProviderService(workerEntry, 'piscina-capability-honesty');

    try {
      // The honest reason the other three proofs are the only convergence path
      // available: this provider offers no recovery surface at all, so nothing
      // can go look at the infrastructure and report what actually happened.
      expect(service.provider.baseCapabilities.supportsRecovery).toBe(false);
      expect('recovery' in service.provider).toBe(false);
      expect(service.provider.allocationLifetime).toBe('provisioner-process-bound');
    } finally {
      await service.dispose();
    }
  });

  it('converges only on a loss proof naming the exact provisioner incarnation', async () => {
    const executionId = 'wfx-exact-incarnation-proof';
    const executionAttemptId = 'attempt-exact-incarnation-proof';
    await repositoryA.createAttempt({
      executionAttemptId,
      executionId,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: 120_000,
    });
    const claim = await beginProcessBoundProvisioning(repositoryA, executionAttemptId, executionId, {
      provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
    });

    // Proof about the very incarnation the attempt was bound to. This is the
    // whole convergence path for a process-bound allocation.
    const proof = makeProcessLossProof(TEST_PROVISIONER_INCARNATION_ID);
    const decision = await repositoryA.recordProvisionerIncarnationLost({
      claim,
      executionId,
      proof,
    });
    expect(decision).toEqual({ kind: 'recorded' });

    expect(await repositoryB.recovery.getAttemptWithAllocation(executionAttemptId)).toMatchObject({
      status: 'settled',
      settlementKind: 'abandoned',
      allocationRef: null,
    });
    // This is pre-allocation: the exact process-loss proof therefore proves
    // that no provider allocation survived. It closes the operation while
    // retaining its authorizing claim as completion provenance.
    expect(await repositoryB.getProviderOperation(executionAttemptId)).toMatchObject({
      ownerId: claim.ownerId,
      token: claim.token,
      leaseExpiresAt: claim.leaseExpiresAt,
      completionEvidence: proof.evidence,
      obligation: 'provisioning-resolution',
    });
  });

  it('retains the provisioning debt for a wrong-incarnation proof and for lease expiry', async () => {
    const executionId = 'wfx-retained-debt';
    const leaseExecutionId = 'wfx-retained-debt-lease';
    const mismatchAttemptId = 'attempt-retained-debt-mismatch';
    const expiredLeaseAttemptId = 'attempt-retained-debt-expired-lease';

    // (a) A proof about a different process says nothing about this one.
    await repositoryA.createAttempt({
      executionAttemptId: mismatchAttemptId,
      bootstrapTimeoutMs: 120_000,
      executionId,
      instruction: makeTestInstruction(),
    });
    const mismatchClaim = await beginProcessBoundProvisioning(repositoryA, mismatchAttemptId, executionId, {
      provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
    });
    expect(
      await repositoryA.recordProvisionerIncarnationLost({
        claim: mismatchClaim,
        executionId,
        proof: makeProcessLossProof(FOREIGN_PROVISIONER_INCARNATION_ID),
      }),
    ).toEqual({ kind: 'incarnation-mismatch', provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID });
    expect(await repositoryB.recovery.getAttemptWithAllocation(mismatchAttemptId)).toMatchObject({
      status: 'provisioning',
      settlementKind: null,
    });
    expect(await repositoryB.getProviderOperation(mismatchAttemptId)).toMatchObject({
      obligation: 'provisioning-resolution',
    });

    // (b) An expired lease is the same claim: it is not proof either. It says
    // the previous holder stopped renewing, which is a statement about a
    // controller, not about whether the allocation survived.
    await repositoryA.createAttempt({
      executionAttemptId: expiredLeaseAttemptId,
      bootstrapTimeoutMs: 120_000,
      executionId: leaseExecutionId,
      instruction: makeTestInstruction(),
    });
    const firstClaim = await beginProcessBoundProvisioning(repositoryA, expiredLeaseAttemptId, leaseExecutionId, {
      provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
      leaseExpiresAt: leaseAt(-60_000),
    });
    expect(firstClaim.generation).toBe(1);

    const takeover = await repositoryB.takeOverProviderOperation({
      executionAttemptId: expiredLeaseAttemptId,
      ownerId: SECOND_CONTROLLER_ID,
      observedAt: new Date().toISOString(),
      leaseExpiresAt: leaseAt(60_000),
    });
    expect(takeover).toMatchObject({
      kind: 'claimed',
      claim: { generation: 2, ownerId: SECOND_CONTROLLER_ID },
    });
    if (takeover.kind !== 'claimed') {
      throw new Error(`Expected the expired operation to be taken over, got '${takeover.kind}'`);
    }

    // Ownership moved and nothing else did: the attempt is exactly as
    // unresolved as it was before the takeover.
    expect(await repositoryA.recovery.getAttemptWithAllocation(expiredLeaseAttemptId)).toMatchObject({
      status: 'provisioning',
      settlementKind: null,
    });

    // The debt is transferable, not dischargeable by transfer: the new owner
    // still has only the one closer, and it still needs the same proof.
    expect(
      await repositoryB.recordProvisionerIncarnationLost({
        claim: takeover.claim,
        executionId: leaseExecutionId,
        proof: makeProcessLossProof(TEST_PROVISIONER_INCARNATION_ID),
      }),
    ).toEqual({ kind: 'recorded' });
  });

  it('does not treat a service rebuilt in the same process as worker loss', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const executionId = 'wfx-service-rebuild';
    const executionAttemptId = 'attempt-service-rebuild';
    let first: ProviderServiceInstance | undefined = createProviderService(workerEntry, 'piscina-service-1');
    let second: ProviderServiceInstance | undefined;

    try {
      const record = await repositoryA.createAttempt({
        executionAttemptId,
        executionId,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: 120_000,
      });
      if (record.bootstrapDeadlineAt === null) throw new Error('Fixture Attempt requires a bootstrap deadline');
      const claim = await beginProcessBoundProvisioning(repositoryA, executionAttemptId, executionId, {
        providerId: first.provider.id,
        provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
      });

      const outcome = await first.provider.provision(
        createWorkflowProvisionRequest(
          makeProvisionableWorkflowConfig({
            executionId,
            busUrl: PROVISION_BUS_URL,
            cancelSubject: `workflow.${executionId}.cancel`,
          }),
          executionAttemptId,
        ),
        new AbortController().signal,
      );
      if (outcome.kind !== 'allocated') throw new Error(`Expected allocation, got '${outcome.kind}'`);
      // Waiting on the acknowledged outcome rather than on elapsed time is what
      // makes this a real worker thread that really ran.
      await expect(first.acknowledgedAttemptId).resolves.toBe(executionAttemptId);
      expect(await repositoryA.recordAllocation({ claim, allocationRef: outcome.allocationRef })).toEqual({
        kind: 'recorded',
      });

      // Restart the service: the first one is torn down completely — its handle
      // released, its worker threads gone — before a second provider over a
      // second runner is built in the same process. Nothing but the process
      // incarnation and the committed rows crosses that boundary, which is what
      // makes the refusal below a statement about durable state rather than
      // about an object that happens to still be alive.
      await outcome.handle.release();
      await first.dispose();
      first = undefined;

      second = createProviderService(workerEntry, 'piscina-service-2');
      expect(second.provider.allocationLifetime).toBe('provisioner-process-bound');

      // The rebuild is not worker loss, and the durable record is what says so:
      // the one closer this lifetime has is submitted, naming this very
      // incarnation, and the repository refuses it because an allocation is
      // recorded against it. A closer that accepted a proof over a live
      // allocation would settle the attempt here instead.
      expect(
        await repositoryB.recordProvisionerIncarnationLost({
          claim,
          executionId,
          proof: makeProcessLossProof(TEST_PROVISIONER_INCARNATION_ID),
        }),
      ).toEqual({ kind: 'allocated', allocationRef: outcome.allocationRef });

      expect(await repositoryB.recovery.getAttemptWithAllocation(executionAttemptId)).toMatchObject({
        provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
        allocationLifetime: 'provisioner-process-bound',
        settlementKind: null,
      });
      expect(await repositoryB.getProviderOperation(executionAttemptId)).toMatchObject({
        obligation: 'allocation-control',
      });
    } finally {
      await second?.dispose();
      await first?.dispose();
    }
  });
});

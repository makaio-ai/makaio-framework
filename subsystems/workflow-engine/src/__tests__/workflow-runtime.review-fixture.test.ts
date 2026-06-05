import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  ArtifactNamespace,
  ArtifactSubjects,
  WorkflowNamespace,
  type ArtifactRelation,
  type ArtifactRevision,
  type WorkflowExecution,
} from '@makaio/contracts';
import { RuntimeContext } from '../runtime/runtime-context.js';
import { executeSequence } from '../runtime/primitive-runtime.js';
import { WorkflowSubjects } from '../namespace.js';
import { type ReviewArtifactData, type ReviewFindings, buildReviewWorkflow } from './fixtures/review-workflow.js';
import type { ArtifactBindingState } from '../artifact-context/artifact-binding.js';
import { createArtifactContext } from '../artifact-context/update-artifact.js';

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

/**
 * Generate a stable fake revision ID.
 * @param n - Monotone counter.
 * @returns Fake revision string.
 */
function fakeRevision(n: number): string {
  return `rev-${String(n).padStart(3, '0')}`;
}

/**
 * Build a minimal initial artifact revision for the review workflow.
 * @param data - Initial artifact data.
 * @returns A fake artifact revision for injection into `ArtifactBindingState`.
 */
function makeInitialRevision(data: ReviewArtifactData): ArtifactRevision<ReviewArtifactData> {
  return {
    kind: 'code-review',
    id: 'artifact-review-1',
    revision: fakeRevision(0),
    schemaVersion: '1',
    scope: { level: 'global' },
    data,
    relations: [],
    actor: { kind: 'workflow-execution', id: 'exec-review-test' },
    timestamp: Date.now(),
  };
}

/**
 * Create an isolated bus instance with both the WorkflowNamespace and
 * ArtifactNamespace registered.
 * @returns A fresh bus instance.
 */
function makeBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(ArtifactNamespace);
  return bus;
}

/**
 * Register a stub artifact `revise` RPC handler on `bus`.
 *
 * Each call increments a monotone counter and returns a new fake revision.
 * The latest data is captured in `capturedRevisions` for assertions.
 * @param bus - Bus instance to register on.
 * @param capturedRevisions - Array populated with each written revision.
 * @returns Cleanup function to deregister the handler.
 */
function registerArtifactReviseStub(
  bus: ReturnType<typeof createBusInstance>,
  capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>>,
): () => void {
  let revisionCounter = 1;
  return bus.on(ArtifactSubjects.revise, (ctx) => {
    const newRevision: ArtifactRevision<ReviewArtifactData> = {
      kind: ctx.payload.revision.kind,
      id: ctx.payload.previous.id,
      revision: fakeRevision(revisionCounter++),
      schemaVersion: ctx.payload.revision.schemaVersion,
      scope: ctx.payload.revision.scope,
      data: ctx.payload.revision.data as ReviewArtifactData,
      relations: (ctx.payload.revision.relations ?? []) as ArtifactRelation[],
      actor: ctx.payload.revision.actor,
      timestamp: Date.now(),
    };
    capturedRevisions.push(newRevision);
    ctx.setResult({ artifact: newRevision as ArtifactRevision });
  });
}

/**
 * Create a minimal WorkflowExecution.
 * @param workflowId - Workflow identifier.
 * @returns Minimal execution record in running status.
 */
function makeExecution(workflowId: string): WorkflowExecution {
  return {
    id: `exec-${workflowId}`,
    workflowId,
    status: 'running',
    inputs: {},
    startedAt: Date.now(),
    scope: { type: 'global' },
  };
}

// ─────────────────────────────────────────────────────────────
// Artifact binding state factory
// ─────────────────────────────────────────────────────────────

/**
 * Build an {@link ArtifactBindingState} seeded with the given initial data.
 * @param initialData - Initial artifact data to seed the binding.
 * @returns Mutable artifact binding state.
 */
function makeArtifactBindingState(
  initialData: ReviewArtifactData = {
    status: 'draft',
    findings: { spec: [], quality: [], testCoverage: [] },
  },
): ArtifactBindingState {
  return {
    current: makeInitialRevision(initialData) as ArtifactRevision,
    schemaVersion: '1',
    statusPath: 'status',
    zodSchema: undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// Shared expression context
// ─────────────────────────────────────────────────────────────

const emptyExpressionCtx = { inputs: {}, trigger: {}, frames: {}, previousSteps: {} };

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('review workflow fixture — artifact data shape', () => {
  it('aggregate station writes findings to the artifact via updateArtifact', async () => {
    const capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>> = [];

    const specFindings = [{ id: 'spec-1', severity: 'info' as const, message: 'Spec OK' }];
    const qualityFindings = [{ id: 'quality-1', severity: 'warning' as const, message: 'Minor style' }];
    const testCoverageFindings = [{ id: 'cov-1', severity: 'info' as const, message: 'Coverage OK' }];

    const bus = makeBus();
    const cleanupRevise = registerArtifactReviseStub(bus, capturedRevisions);

    const bindingState = makeArtifactBindingState();

    let capturedFindings: ReviewFindings | undefined;

    // Run only up to the 'aggregate' station (before the gate) to avoid
    // needing a gate responder. We test a sub-sequence directly.
    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: specFindings }),
      onQuality: async () => ({ findings: qualityFindings }),
      onTestCoverage: async () => ({ findings: testCoverageFindings }),
      onAggregate: async (ctx) => {
        const findings: ReviewFindings = {
          spec: specFindings,
          quality: qualityFindings,
          testCoverage: testCoverageFindings,
        };
        if (ctx.artifact !== undefined) {
          await ctx.artifact.updateArtifact({ operation: 'merge', data: { findings } });
          await ctx.artifact.updateStatus('draft');
        }
        capturedFindings = findings;
        return findings;
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-test',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingState,
    );

    // Execute just the first three nodes in the root sequence: parallel + aggregate
    // (skip the gate and apply-fix for this focused test).
    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2), // parallel + aggregate
    };

    const outcome = await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(capturedFindings).toBeDefined();
    expect(capturedFindings?.spec).toHaveLength(1);
    expect(capturedFindings?.quality).toHaveLength(1);
    expect(capturedFindings?.testCoverage).toHaveLength(1);

    // Two revisions: one for findings merge, one for status update.
    expect(capturedRevisions).toHaveLength(2);
    expect(capturedRevisions[0]?.data.findings.spec).toHaveLength(1);
    expect(capturedRevisions[1]?.data.status).toBe('draft');

    cleanupRevise();
  });

  it('updateArtifact merge operation deep-merges findings without replacing other fields', async () => {
    const capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>> = [];

    const bus = makeBus();
    const cleanupRevise = registerArtifactReviseStub(bus, capturedRevisions);

    const initialData: ReviewArtifactData = {
      status: 'draft',
      findings: {
        spec: [{ id: 'pre-existing', severity: 'info', message: 'Pre-existing spec' }],
        quality: [],
        testCoverage: [],
      },
    };
    const bindingState = makeArtifactBindingState(initialData);

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        // Only add quality findings, leaving spec findings from initial data.
        const newQualityFindings = [{ id: 'q-1', severity: 'warning' as const, message: 'Quality' }];
        if (ctx.artifact !== undefined) {
          await ctx.artifact.updateArtifact({
            operation: 'merge',
            data: {
              findings: {
                spec: ctx.artifact.data.findings.spec,
                quality: newQualityFindings,
                testCoverage: [],
              },
            },
          });
        }
        return {
          spec: ctx.artifact?.data.findings.spec ?? [],
          quality: newQualityFindings,
          testCoverage: [],
        };
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-merge-test',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingState,
    );

    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2),
    };

    await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    // The merge should have written one revision.
    expect(capturedRevisions).toHaveLength(1);
    expect(capturedRevisions[0]?.data.findings.quality).toHaveLength(1);
    // Pre-existing spec finding from initial data must still be present.
    expect(capturedRevisions[0]?.data.findings.spec).toHaveLength(1);
    expect(capturedRevisions[0]?.data.findings.spec[0]?.id).toBe('pre-existing');

    cleanupRevise();
  });

  it('updateStatus writes a new revision with the target status field updated', async () => {
    const capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>> = [];

    const bus = makeBus();
    const cleanupRevise = registerArtifactReviseStub(bus, capturedRevisions);

    const bindingState = makeArtifactBindingState();

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        if (ctx.artifact !== undefined) {
          await ctx.artifact.updateStatus('draft');
        }
        return { spec: [], quality: [], testCoverage: [] };
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-status-test',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingState,
    );

    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2),
    };

    await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    expect(capturedRevisions).toHaveLength(1);
    expect(capturedRevisions[0]?.data.status).toBe('draft');

    cleanupRevise();
  });

  it('triage reject path writes rejected status and skips fix output', async () => {
    const capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>> = [];

    const bus = makeBus();
    const cleanupRevise = registerArtifactReviseStub(bus, capturedRevisions);

    const bindingState = makeArtifactBindingState();

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        if (ctx.artifact !== undefined) {
          await ctx.artifact.updateArtifact({
            operation: 'merge',
            data: { findings: { spec: [], quality: [], testCoverage: [] } },
          });
          await ctx.artifact.updateStatus('draft');
        }
        return { spec: [], quality: [], testCoverage: [] };
      },
      onFix: async () => {
        throw new Error('fix station must not run for rejected triage');
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-reject-triage',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingState,
    );

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-review-reject-triage',
        gateId: 'triage',
        // Approve the gate so the workflow can apply the domain triage
        // decision carried in resumeData.
        action: 'approve',
        resumeData: { action: 'reject', rationale: 'not ready' },
      });
    });

    const outcome = await executeSequence(built.definition.root, runtimeCtx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(capturedRevisions.at(-1)?.data.status).toBe('rejected');
    expect(capturedRevisions.at(-1)?.data.fixOutput).toBeUndefined();

    cleanupRevise();
  });

  it('triage approve path writes triaged before the fix station writes fixed', async () => {
    const capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>> = [];

    const bus = makeBus();
    const cleanupRevise = registerArtifactReviseStub(bus, capturedRevisions);

    const bindingState = makeArtifactBindingState();

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        if (ctx.artifact !== undefined) {
          await ctx.artifact.updateArtifact({
            operation: 'merge',
            data: { findings: { spec: [], quality: [], testCoverage: [] } },
          });
          await ctx.artifact.updateStatus('draft');
        }
        return { spec: [], quality: [], testCoverage: [] };
      },
      onFix: async () => 'approved fixes applied',
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-approve-triage',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingState,
    );

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-review-approve-triage',
        gateId: 'triage',
        action: 'approve',
        resumeData: { action: 'approve', rationale: 'ship it' },
      });
    });

    const outcome = await executeSequence(built.definition.root, runtimeCtx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(capturedRevisions.map((revision) => revision.data.status)).toEqual([
      'draft',
      'draft',
      'triaged',
      'triaged',
      'fixed',
    ]);
    expect(capturedRevisions.at(-1)?.data.fixOutput).toBe('approved fixes applied');

    cleanupRevise();
  });

  it('updateStatus throws when no statusPath is configured', async () => {
    const bus = makeBus();

    // Build with a binding state that has no statusPath.
    const bindingStateNoStatusPath: ArtifactBindingState = {
      current: makeInitialRevision({
        status: 'draft',
        findings: { spec: [], quality: [], testCoverage: [] },
      }) as ArtifactRevision,
      schemaVersion: '1',
      statusPath: undefined,
      zodSchema: undefined,
    };

    let capturedError: Error | undefined;

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        if (ctx.artifact !== undefined) {
          try {
            await ctx.artifact.updateStatus('draft');
          } catch (err) {
            capturedError = err instanceof Error ? err : new Error(String(err));
          }
        }
        return { spec: [], quality: [], testCoverage: [] };
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-no-status-path',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingStateNoStatusPath,
    );

    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2),
    };

    await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    expect(capturedError).toBeDefined();
    expect(capturedError?.message).toContain('statusPath');
  });

  it('ctx.artifact.data is a frozen snapshot — not mutated across updateArtifact calls', async () => {
    const capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>> = [];

    const bus = makeBus();
    const cleanupRevise = registerArtifactReviseStub(bus, capturedRevisions);

    const bindingState = makeArtifactBindingState();

    let snapshotBefore: ReviewArtifactData | undefined;
    let snapshotAfter: ReviewArtifactData | undefined;

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        if (ctx.artifact !== undefined) {
          // Capture the snapshot before updating.
          snapshotBefore = { ...ctx.artifact.data };
          await ctx.artifact.updateArtifact({
            operation: 'merge',
            data: { status: 'draft' },
          });
          // The original snapshot must not have been mutated.
          snapshotAfter = { ...ctx.artifact.data };
        }
        return { spec: [], quality: [], testCoverage: [] };
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-snapshot-test',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingState,
    );

    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2),
    };

    await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    // ctx.artifact.data is snapped at context creation time and must not change.
    expect(snapshotBefore?.status).toBe('draft');
    // snapshotAfter captures a fresh spread at the same reference — data should
    // be the same frozen object, not the updated one.
    expect(snapshotAfter?.status).toBe('draft');

    expect(capturedRevisions).toHaveLength(1);

    cleanupRevise();
  });
});

describe('review workflow fixture — workflow.artifact.updated events', () => {
  it('emits workflow.artifact.updated after each updateArtifact call', async () => {
    const capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>> = [];
    const artifactUpdatedEvents: unknown[] = [];

    const bus = makeBus();
    const cleanupRevise = registerArtifactReviseStub(bus, capturedRevisions);

    bus.on(WorkflowSubjects.artifact.updated, (ctx) => {
      artifactUpdatedEvents.push(ctx.payload);
    });

    const bindingState = makeArtifactBindingState();

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        if (ctx.artifact !== undefined) {
          await ctx.artifact.updateArtifact({
            operation: 'merge',
            data: { findings: { spec: [], quality: [], testCoverage: [] } },
          });
          await ctx.artifact.updateStatus('draft');
        }
        return { spec: [], quality: [], testCoverage: [] };
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-events-test',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingState,
    );

    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2),
    };

    await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    // Allow microtasks from fire-and-forget event emission to settle.
    await vi.waitFor(() => {
      expect(artifactUpdatedEvents).toHaveLength(2);
    });

    const firstEvent = artifactUpdatedEvents[0] as {
      executionId: string;
      artifactRef: { kind: string; id: string };
      operation: string;
      revision: string;
    };

    expect(firstEvent.executionId).toBe('exec-review-events-test');
    expect(firstEvent.artifactRef.kind).toBe('code-review');
    expect(firstEvent.operation).toBe('merge');
    expect(typeof firstEvent.revision).toBe('string');

    cleanupRevise();
  });
});

describe('review workflow fixture — parallel branch outputs in WorkLog', () => {
  it('each parallel delegate branch output is individually accessible in the parallel output', async () => {
    const bus = makeBus();

    const specFindings = [{ id: 's1', severity: 'info' as const, message: 'Spec OK' }];
    const qualityFindings = [{ id: 'q1', severity: 'warning' as const, message: 'Quality warning' }];
    const testCoverageFindings = [{ id: 'c1', severity: 'info' as const, message: 'Coverage OK' }];

    let capturedBranchOutputs: Record<string, { status: string; value?: unknown }> | undefined;

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: specFindings }),
      onQuality: async () => ({ findings: qualityFindings }),
      onTestCoverage: async () => ({ findings: testCoverageFindings }),
      onAggregate: async (ctx) => {
        // Capture raw branch outputs from the parallel node.
        const parallelResult = ctx.previousSteps['review-delegates'] as
          | { output: { branches: Record<string, { status: string; value?: unknown }> } }
          | undefined;
        capturedBranchOutputs = parallelResult?.output?.branches;
        return { spec: specFindings, quality: qualityFindings, testCoverage: testCoverageFindings };
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-worklog-test',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
    );

    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2),
    };

    const outcome = await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(capturedBranchOutputs).toBeDefined();

    // Each branch should be fulfilled with delegate output.
    expect(capturedBranchOutputs?.['spec-review']).toMatchObject({ status: 'fulfilled' });
    expect(capturedBranchOutputs?.['quality-review']).toMatchObject({ status: 'fulfilled' });
    expect(capturedBranchOutputs?.['test-coverage-review']).toMatchObject({ status: 'fulfilled' });

    // Raw findings accessible per branch.
    const specBranch = capturedBranchOutputs?.['spec-review'] as { status: string; value?: { findings: unknown[] } };
    expect(specBranch.value?.findings).toHaveLength(1);
    expect((specBranch.value?.findings[0] as { id: string })?.id).toBe('s1');
  });
});

describe('review workflow fixture — functional updateArtifact', () => {
  it('functional updater receives current data and can produce a new full state', async () => {
    const capturedRevisions: Array<ArtifactRevision<ReviewArtifactData>> = [];

    const bus = makeBus();
    const cleanupRevise = registerArtifactReviseStub(bus, capturedRevisions);

    const initialFindings = [{ id: 'existing', severity: 'info' as const, message: 'Existing' }];
    const initialData: ReviewArtifactData = {
      status: 'draft',
      findings: {
        spec: initialFindings,
        quality: [],
        testCoverage: [],
      },
    };
    const bindingState = makeArtifactBindingState(initialData);

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        const newFinding = { id: 'new', severity: 'warning' as const, message: 'New finding' };
        if (ctx.artifact !== undefined) {
          await ctx.artifact.updateArtifact(async (current) => ({
            ...current,
            findings: {
              ...current.findings,
              quality: [...current.findings.quality, newFinding],
            },
          }));
        }
        return {
          spec: ctx.artifact?.data.findings.spec ?? [],
          quality: [newFinding],
          testCoverage: [],
        };
      },
    });

    const runtimeCtx = new RuntimeContext(
      'exec-review-functional-test',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
      undefined,
      bindingState,
    );

    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2),
    };

    await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    expect(capturedRevisions).toHaveLength(1);
    // Functional updater appended a quality finding.
    expect(capturedRevisions[0]?.data.findings.quality).toHaveLength(1);
    expect(capturedRevisions[0]?.data.findings.quality[0]?.id).toBe('new');
    // Spec findings from initial data must still be present.
    expect(capturedRevisions[0]?.data.findings.spec).toHaveLength(1);

    cleanupRevise();
  });

  it('serializes overlapping updates against the latest artifact revision', async () => {
    const bus = makeBus();
    const capturedRevisions: Array<ArtifactRevision<Record<string, unknown>>> = [];
    const previousRevisions: string[] = [];
    let revisionCounter = 1;
    let releaseFirstRevision: () => void = () => {
      throw new Error('First revision was not captured.');
    };
    let firstRevisionStarted: (() => void) | undefined;

    const firstRevisionGate = new Promise<void>((resolve) => {
      releaseFirstRevision = resolve;
    });
    const firstRevisionEntered = new Promise<void>((resolve) => {
      firstRevisionStarted = resolve;
    });

    const cleanupRevise = bus.on(ArtifactSubjects.revise, async (ctx) => {
      previousRevisions.push(ctx.payload.previous.revision);
      const revision = fakeRevision(revisionCounter++);

      if (previousRevisions.length === 1) {
        firstRevisionStarted?.();
        await firstRevisionGate;
      }

      const newRevision: ArtifactRevision<Record<string, unknown>> = {
        kind: ctx.payload.revision.kind,
        id: ctx.payload.previous.id,
        revision,
        schemaVersion: ctx.payload.revision.schemaVersion,
        scope: ctx.payload.revision.scope,
        data: ctx.payload.revision.data,
        relations: (ctx.payload.revision.relations ?? []) as ArtifactRelation[],
        actor: ctx.payload.revision.actor,
        timestamp: Date.now(),
      };
      capturedRevisions.push(newRevision);
      ctx.setResult({ artifact: newRevision as ArtifactRevision });
    });

    const bindingState: ArtifactBindingState = {
      current: {
        kind: 'note',
        id: 'artifact-overlap-1',
        revision: fakeRevision(0),
        schemaVersion: '1',
        scope: { level: 'global' },
        data: { messages: [] },
        relations: [],
        actor: { kind: 'workflow-execution', id: 'exec-overlap-test' },
        timestamp: Date.now(),
      },
      schemaVersion: '1',
      statusPath: undefined,
      zodSchema: undefined,
    };

    const artifact = createArtifactContext<Record<string, unknown>>({
      executionId: 'exec-overlap-test',
      frameId: 'frame-overlap-test',
      bindingState,
      bus,
    });

    const firstUpdate = artifact.updateArtifact({
      operation: 'append',
      data: { messages: ['first'] },
    });
    await firstRevisionEntered;

    const secondUpdate = artifact.updateArtifact({
      operation: 'append',
      data: { messages: ['second'] },
    });

    releaseFirstRevision();

    await Promise.all([firstUpdate, secondUpdate]);

    expect(previousRevisions).toEqual([fakeRevision(0), fakeRevision(1)]);
    expect(capturedRevisions).toHaveLength(2);
    expect(bindingState.current.revision).toBe(fakeRevision(2));
    expect(bindingState.current.data).toEqual({ messages: ['first', 'second'] });

    cleanupRevise();
  });
});

describe('review workflow fixture — no artifact binding', () => {
  it('stations run normally when no artifact binding is configured', async () => {
    const bus = makeBus();

    let aggregateCalled = false;

    const built = buildReviewWorkflow({
      onSpec: async () => ({ findings: [] }),
      onQuality: async () => ({ findings: [] }),
      onTestCoverage: async () => ({ findings: [] }),
      onAggregate: async (ctx) => {
        aggregateCalled = true;
        // ctx.artifact should be undefined when no binding state is injected.
        expect(ctx.artifact).toBeUndefined();
        return { spec: [], quality: [], testCoverage: [] };
      },
    });

    // Intentionally no artifactBinding injected.
    const runtimeCtx = new RuntimeContext(
      'exec-review-no-binding',
      'review-workflow',
      built.definition,
      makeExecution('review-workflow'),
      built.runtimeHandlers,
      bus,
      new AbortController().signal,
    );

    const subSequence = {
      id: 'test-sub',
      type: 'sequence' as const,
      nodes: built.definition.root.nodes.slice(0, 2),
    };

    const outcome = await executeSequence(subSequence, runtimeCtx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(aggregateCalled).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createWorkflowCancelSubject } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { asExecutable, createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
  type GateStepInput,
} from './workflow-executor.test-setup.js';

describe('WorkflowExecutor Gate Steps', () => {
  let setup: WorkflowExecutorTestSetup;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    await teardownWorkflowExecutorTest(setup);
  });

  function registerGateResponder(
    action: 'approve' | 'reject',
    delayMs = 50,
  ): { gateRequests: Array<{ executionId: string; stepId: string }>; cleanup: () => void } {
    const gateRequests: Array<{ executionId: string; stepId: string }> = [];
    const cleanup = MakaioBus.on(WorkflowSubjects.gate.requested, (ctx) => {
      gateRequests.push({ executionId: ctx.payload.executionId, stepId: ctx.payload.stepId });
      setTimeout(() => {
        void MakaioBus.request(WorkflowSubjects.gate.respond, {
          executionId: ctx.payload.executionId,
          stepId: ctx.payload.stepId,
          action,
        });
      }, delayMs);
    });
    return { gateRequests, cleanup };
  }

  async function setupGateWorkflow(
    gate: GateStepInput,
    extraSteps: Array<{ id: string; type: 'agent'; prompt: string; needs?: string[] }> = [],
  ) {
    const workflow = createWorkflowDefinition({
      steps: [gate, ...extraSteps],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    return workflow;
  }

  it('completes gate step when user approves via bus response', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Proceed?',
      autoAction: 'reject',
      timeoutMs: null,
    });

    const { gateRequests, cleanup } = registerGateResponder('approve');
    setup.cleanupFns.push(cleanup);

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    expect(gateRequests).toHaveLength(1);
    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    expect(execution?.steps['confirm']?.status).toBe('completed');
    expect(asExecutable(execution?.steps['confirm'])?.result).toContain('Approved');
  });

  it('accepts immediate gate response in the same event tick', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Proceed?',
      autoAction: 'reject',
      timeoutMs: null,
    });

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.gate.requested, async (ctx) => {
        await MakaioBus.request(WorkflowSubjects.gate.respond, {
          executionId: ctx.payload.executionId,
          stepId: ctx.payload.stepId,
          action: 'approve',
        });
      }),
    );

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));
  });

  it('fails gate step and workflow when user rejects via bus response', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Proceed?',
      autoAction: 'approve',
      timeoutMs: null,
    });

    const { cleanup } = registerGateResponder('reject');
    setup.cleanupFns.push(cleanup);

    const failedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(failedExecutions).toEqual([executionId]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
    expect(execution?.steps['confirm']?.status).toBe('failed');
    expect(execution?.steps['confirm']?.error).toContain('Rejected');
  });

  it('auto-approves gate step after timeout with autoAction "approve"', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Proceed?',
      autoAction: 'approve',
      timeoutMs: 100,
    });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 3000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    expect(execution?.steps['confirm']?.status).toBe('completed');
    expect(asExecutable(execution?.steps['confirm'])?.result).toContain('Auto-approved');
  });

  it('auto-rejects gate step after timeout with autoAction "reject"', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Proceed?',
      autoAction: 'reject',
      timeoutMs: 100,
    });

    const failedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(failedExecutions).toEqual([executionId]), { timeout: 3000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
    expect(execution?.steps['confirm']?.status).toBe('failed');
    expect(execution?.steps['confirm']?.error).toContain('Auto-rejected');
  });

  it('blocks indefinitely when timeoutMs is null (resolved via user action)', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Proceed?',
      autoAction: 'reject',
      timeoutMs: null,
    });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { gateRequests, cleanup } = registerGateResponder('approve', 200);
    setup.cleanupFns.push(cleanup);

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 3000 });

    expect(gateRequests).toHaveLength(1);
    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(asExecutable(execution?.steps['confirm'])?.result).toContain('Approved by user');
  });

  it('returns accepted: false when user responds after timeout (race condition)', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Proceed?',
      autoAction: 'approve',
      timeoutMs: 50,
    });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    let lateResponseAccepted: boolean | undefined;
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.gate.requested, (ctx) => {
        setTimeout(async () => {
          const result = await MakaioBus.request(WorkflowSubjects.gate.respond, {
            executionId: ctx.payload.executionId,
            stepId: ctx.payload.stepId,
            action: 'reject',
          });
          lateResponseAccepted = result.accepted;
        }, 200);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 3000 });
    await vi.waitFor(() => expect(lateResponseAccepted).toBe(false), { timeout: 3000 });
  });

  it('cancels a waiting gate step', async () => {
    const workflow = createWorkflowDefinition({
      steps: [
        {
          id: 'gate-step',
          type: 'gate' as const,
          prompt: 'Approve?',
          autoAction: 'reject' as const,
          timeoutMs: null,
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    let gateRequested = false;
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.gate.requested, () => {
        gateRequested = true;
      }),
    );

    const cancelledExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
        cancelledExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
    });

    await vi.waitFor(() => expect(gateRequested).toBe(true));

    const { cancelled } = await MakaioBus.request(WorkflowSubjects.cancel, { executionId });
    expect(cancelled).toBe(true);

    await vi.waitFor(() => expect(cancelledExecutions).toEqual([executionId]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('cancelled');
    expect(execution?.steps['gate-step']?.status).toBe('failed');
    expect(execution?.steps['gate-step']?.error).toBe('Workflow cancelled');

    await expect(
      MakaioBus.request(WorkflowSubjects.gate.respond, { executionId, stepId: 'gate-step', action: 'approve' }),
    ).resolves.toEqual({ accepted: false });
  });

  it('resolves template interpolation in gate prompt', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Delete branch {{ trigger.branch }}?',
      autoAction: 'reject',
      timeoutMs: null,
    });

    const capturedMessages: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.gate.requested, (ctx) => {
        capturedMessages.push(ctx.payload.message);
      }),
    );

    const { gateRequests, cleanup } = registerGateResponder('approve');
    setup.cleanupFns.push(cleanup);

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      triggerPayload: { branch: 'feature/my-branch' },
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    expect(gateRequests).toHaveLength(1);
    expect(capturedMessages).toEqual(['Delete branch feature/my-branch?']);
  });

  it('transitions step status: pending -> waiting -> completed on approve', async () => {
    const workflow = await setupGateWorkflow({
      id: 'confirm',
      type: 'gate',
      prompt: 'Proceed?',
      autoAction: 'reject',
      timeoutMs: null,
    });

    const stepStatuses: string[] = [];

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.gate.requested, async (ctx) => {
        const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
          executionId: ctx.payload.executionId,
        });
        if (execution?.steps['confirm']?.status) {
          stepStatuses.push(execution.steps['confirm'].status);
        }
        setTimeout(() => {
          void MakaioBus.request(WorkflowSubjects.gate.respond, {
            executionId: ctx.payload.executionId,
            stepId: ctx.payload.stepId,
            action: 'approve',
          });
        }, 50);
      }),
    );

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    expect(stepStatuses).toEqual(['waiting']);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['confirm']?.status).toBe('completed');
  });

  it('resolves gate.awaitApproval RPC after gate.respond is sent in same tick', async () => {
    // Arrange: listen for gate.requested and immediately respond via gate.respond
    // in the same synchronous handler tick — the pending promise must already be
    // registered before gate.requested is emitted, so the immediate response lands.
    let gateRequestedCount = 0;

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.gate.requested, async (ctx) => {
        gateRequestedCount++;
        // Respond in the same tick — the pending promise must be registered first.
        await MakaioBus.request(WorkflowSubjects.gate.respond, {
          executionId: ctx.payload.executionId,
          stepId: ctx.payload.stepId,
          action: 'approve',
        });
      }),
    );

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    // Exercise the gate.awaitApproval RPC path directly.
    const approvalPromise = MakaioBus.request(WorkflowSubjects.gate.awaitApproval, {
      executionId: 'exec-test-await',
      stepId: 'gate-await-test',
      workflowId: 'wf-test',
      workflowName: 'Test Workflow',
      title: 'Approve?',
      message: 'Proceed with the action?',
      autoAction: 'reject',
      timeoutMs: null,
      openedAt: Date.now(),
      stepType: 'gate',
    });

    const resolution = await approvalPromise;

    expect(resolution.action).toBe('approve');
    expect(resolution.source).toBe('user');
    expect(gateRequestedCount).toBe(1);
  });

  it('resolves gate.awaitApproval RPC when the workflow cancel subject is emitted', async () => {
    const requested: Array<{ executionId: string; stepId: string }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.gate.requested, (ctx) => {
        requested.push({ executionId: ctx.payload.executionId, stepId: ctx.payload.stepId });
      }),
    );

    const approvalPromise = MakaioBus.request(WorkflowSubjects.gate.awaitApproval, {
      executionId: 'exec-test-cancel',
      stepId: 'gate-await-cancel',
      workflowId: 'wf-test',
      workflowName: 'Test Workflow',
      title: 'Approve?',
      message: 'Proceed with the action?',
      autoAction: 'reject',
      timeoutMs: null,
      openedAt: Date.now(),
      stepType: 'gate',
    });

    await vi.waitFor(() =>
      expect(requested).toEqual([{ executionId: 'exec-test-cancel', stepId: 'gate-await-cancel' }]),
    );

    await MakaioBus.emit(createWorkflowCancelSubject('workflow.exec-test-cancel.cancel'), {
      executionId: 'exec-test-cancel',
      reason: 'test cancellation',
    });

    await expect(approvalPromise).resolves.toEqual({ action: 'reject', source: 'timeout' });
    await expect(
      MakaioBus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-test-cancel',
        stepId: 'gate-await-cancel',
        action: 'approve',
      }),
    ).resolves.toEqual({ accepted: false });
  });
});

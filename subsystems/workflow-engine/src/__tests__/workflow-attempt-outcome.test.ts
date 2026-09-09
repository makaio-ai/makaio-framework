import { describe, expect, it } from 'vitest';
import { WorkflowWorkerConfigSchema, type ExecutionAttemptOutcome, type WorkflowRunResult } from '@makaio/contracts';
import { buildWorkflowAttemptInstruction } from '../workflow-attempt-instruction.js';
import {
  decodeWorkflowAttemptOutcome,
  toCommittedWorkflowRunnerResult,
  toCommittedWorkflowRunnerCompletion,
  workflowAttemptOutcomeCodec,
  type WorkflowAttemptOutcome,
} from '../workflow-attempt-outcome.js';

const identity = { executionId: 'execution-1', workflowId: 'workflow-1' };
const instruction = buildWorkflowAttemptInstruction({
  id: 'instruction-1',
  revision: 'revision-1',
  preservation: { required: [] },
  config: WorkflowWorkerConfigSchema.parse({
    ...identity,
    source: { kind: 'source', filename: 'workflow.ts', source: 'export default workflow;' },
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.execution-1.cancel',
  }),
});

describe('workflow Attempt outcome owner adapter', () => {
  it.each([
    { ...identity, status: 'completed' },
    { ...identity, status: 'paused', pausedAtGateId: 'gate-1', pausedAtFrameId: 'frame-1' },
    { kind: 'technical-failure', stage: 'workload-invocation', message: 'Process did not stop' },
    { kind: 'cancelled', reason: 'Worker stopped' },
  ] satisfies WorkflowAttemptOutcome[])('retains a recorded-only fact without fabricating a runner result: %j', (outcome) => {
    const acceptedOutcome = {
      outcome,
      acceptance: 'recorded-only' as const,
      controlObservation: { controlRevision: 0, cancellation: null },
    };
    const completion = toCommittedWorkflowRunnerCompletion(acceptedOutcome, identity);
    expect(completion).toEqual({ state: 'authority-recorded-only', ...identity, acceptedOutcome });
    expect(completion).not.toHaveProperty('result');
  });

  it('keeps an unknown legacy observation unknown in a recorded-only completion', () => {
    const completion = toCommittedWorkflowRunnerCompletion(
      {
        outcome: { ...identity, status: 'completed' },
        acceptance: 'recorded-only',
        controlObservation: null,
      },
      identity,
    );
    expect(completion).toMatchObject({
      state: 'authority-recorded-only',
      acceptedOutcome: { controlObservation: null },
    });
  });

  it('refuses a mismatched owner identity even for recorded-only acceptance', () => {
    expect(() =>
      toCommittedWorkflowRunnerCompletion(
        {
          outcome: { ...identity, executionId: 'wrong-owner', status: 'completed' },
          acceptance: 'recorded-only',
          controlObservation: null,
        },
        identity,
      ),
    ).toThrow('owner identity');
  });

  it.each([
    { kind: 'technical-failure', stage: 'startup', message: 'Invalid workflow input' },
    { kind: 'cancelled', reason: 'Stopped before the workflow could be loaded' },
  ] as const)('decodes $kind without requiring valid workflow-specific input', (outcome) => {
    const malformed = { ...instruction, workload: { ...instruction.workload, input: {} } };
    expect(decodeWorkflowAttemptOutcome({ instruction: malformed, outcome })).toEqual(outcome);
  });

  it('still rejects workload results whose frozen workflow input cannot be decoded', () => {
    const malformed = { ...instruction, workload: { ...instruction.workload, input: {} } };
    expect(() =>
      decodeWorkflowAttemptOutcome({
        instruction: malformed,
        outcome: { kind: 'workload-result', result: { ...identity, status: 'completed' } },
      }),
    ).toThrow();
  });

  it.each([
    'startup',
    'workspace-preparation',
    'workload-invocation',
  ] as const)('keeps %s failure technical through decoding and durable codec round-trip', (stage) => {
    const report: ExecutionAttemptOutcome = { kind: 'technical-failure', stage, message: 'Test failure' };
    const decoded = decodeWorkflowAttemptOutcome({ instruction, outcome: report });
    const persisted = workflowAttemptOutcomeCodec.serialize(decoded);
    expect(workflowAttemptOutcomeCodec.parse(JSON.parse(persisted))).toEqual(report);
    expect(decoded).not.toHaveProperty('status');
    expect(decoded).not.toHaveProperty('workflowId');
  });

  it('preserves completed, failed, cancelled, and paused workflow outcomes', () => {
    const results: WorkflowRunResult[] = [
      { ...identity, status: 'completed' },
      { ...identity, status: 'failed', error: 'Workflow error' },
      { ...identity, status: 'cancelled', reason: 'Requested by owner' },
      { ...identity, status: 'paused', pausedAtGateId: 'review-gate', pausedAtFrameId: 'frame-1' },
    ];
    for (const result of results) {
      const decoded = decodeWorkflowAttemptOutcome({ instruction, outcome: { kind: 'workload-result', result } });
      expect(decoded).toEqual(result);
      expect(workflowAttemptOutcomeCodec.parse(JSON.parse(workflowAttemptOutcomeCodec.serialize(decoded)))).toEqual(
        result,
      );
    }
  });

  it.each([
    undefined,
    'Owner requested stop',
  ])('retains confirmed cancellation with reason %s as its own canonical kind', (reason) => {
    const report: ExecutionAttemptOutcome = { kind: 'cancelled', ...(reason !== undefined ? { reason } : {}) };
    const decoded = decodeWorkflowAttemptOutcome({ instruction, outcome: report });
    const persisted = workflowAttemptOutcomeCodec.serialize(decoded);
    expect(workflowAttemptOutcomeCodec.parse(JSON.parse(persisted))).toEqual(report);
    expect(decoded).not.toHaveProperty('status');
    expect(decoded).not.toHaveProperty('workflowId');
    expect(toCommittedWorkflowRunnerResult(decoded, identity)).toEqual({
      ...identity,
      status: 'cancelled',
      ...(reason !== undefined ? { reason } : {}),
    });
    expect(workflowAttemptOutcomeCodec.serialize(decoded)).toBe(persisted);
  });

  it('correlates workflow results against the frozen instruction, not mutable workflow storage', () => {
    for (const result of [
      { executionId: 'other-execution', workflowId: 'workflow-1', status: 'completed' },
      { executionId: 'execution-1', workflowId: 'other-workflow', status: 'completed' },
    ]) {
      expect(() => decodeWorkflowAttemptOutcome({ instruction, outcome: { kind: 'workload-result', result } })).toThrow(
        'frozen instruction',
      );
    }
  });

  it('rejects undecoded generic envelopes and incomplete workflow results in the owner codec', () => {
    expect(() =>
      workflowAttemptOutcomeCodec.parse({ kind: 'workload-result', result: { ...identity, status: 'completed' } }),
    ).toThrow();
    expect(() =>
      workflowAttemptOutcomeCodec.parse({ ...identity, status: 'paused', pausedAtGateId: 'review-gate' }),
    ).toThrow();
    expect(() =>
      workflowAttemptOutcomeCodec.parse({ kind: 'technical-failure', stage: 'unknown', message: 'Failed' }),
    ).toThrow();
  });

  it('projects a technical failure for an already-converged runner without changing its stored representation', () => {
    const outcome: WorkflowAttemptOutcome = {
      kind: 'technical-failure',
      stage: 'workspace-preparation',
      message: 'Setup command failed',
    };
    const persisted = workflowAttemptOutcomeCodec.serialize(outcome);
    expect(toCommittedWorkflowRunnerResult(outcome, identity)).toEqual({
      ...identity,
      status: 'failed',
      error: 'workspace-preparation: Setup command failed',
    });
    expect(workflowAttemptOutcomeCodec.serialize(outcome)).toBe(persisted);
    expect(workflowAttemptOutcomeCodec.parse(JSON.parse(persisted))).toEqual(outcome);
  });

  it('retains pause identity and refuses mismatched committed workflow results', () => {
    const paused: WorkflowRunResult = {
      ...identity,
      status: 'paused',
      pausedAtGateId: 'gate-1',
      pausedAtFrameId: 'frame-1',
    };
    expect(toCommittedWorkflowRunnerResult(paused, identity)).toEqual(paused);
    expect(() => toCommittedWorkflowRunnerResult(paused, { ...identity, executionId: 'another-execution' })).toThrow(
      'owner identity',
    );
  });
});

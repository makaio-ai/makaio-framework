import { describe, expect, it } from 'vitest';
import {
  AgentWorkflowStepSchema,
  CompositeStepStateSchema,
  ExecutableStepStateSchema,
  ForEachExpansionSnapshotSchema,
  StepStateSchema,
  WorkflowResolvedRoleSchema,
} from '../schemas.js';
import { WorkflowSubjects } from '../namespace.js';

describe('WorkflowNamespace', () => {
  it('exposes dotted lifecycle subjects as nested accessors', () => {
    expect(WorkflowSubjects.start.subject).toBe('start');
    expect(WorkflowSubjects.gate.respond.subject).toBe('gate.respond');
    expect(WorkflowSubjects.gate.requested.subject).toBe('gate.requested');
    expect(WorkflowSubjects.execution.started.subject).toBe('execution.started');
    expect(WorkflowSubjects.step.beforeStart.subject).toBe('step.beforeStart');
    expect(WorkflowSubjects.step.completed.subject).toBe('step.completed');
  });
});

describe('AgentWorkflowStepSchema', () => {
  it('accepts and preserves harnessId and contextMode fields', () => {
    const step = AgentWorkflowStepSchema.parse({
      id: 'review',
      type: 'agent',
      prompt: 'Review {{ inputs.path }}',
      harnessId: 'harness-reviewer',
      contextMode: 'fresh',
    });

    expect(step).toMatchObject({
      harnessId: 'harness-reviewer',
      contextMode: 'fresh',
    });
  });

  it('accepts a step without harnessId and contextMode (both optional)', () => {
    const step = AgentWorkflowStepSchema.parse({
      id: 'simple',
      type: 'agent',
      prompt: 'Do something',
    });

    expect(step.harnessId).toBeUndefined();
    expect(step.contextMode).toBeUndefined();
  });

  it('rejects invalid contextMode values', () => {
    expect(() =>
      AgentWorkflowStepSchema.parse({
        id: 'bad',
        type: 'agent',
        prompt: 'Do something',
        contextMode: 'invalid-mode',
      }),
    ).toThrow();
  });

  it('accepts and preserves the optional role field', () => {
    const step = AgentWorkflowStepSchema.parse({
      id: 'review',
      type: 'agent',
      prompt: 'Review the spec',
      role: 'spec-reviewer',
    });

    expect(step.role).toBe('spec-reviewer');
  });

  it('accepts a step without role (optional)', () => {
    const step = AgentWorkflowStepSchema.parse({
      id: 'simple',
      type: 'agent',
      prompt: 'Do something',
    });

    expect(step.role).toBeUndefined();
  });

  it('rejects an empty role string', () => {
    expect(() =>
      AgentWorkflowStepSchema.parse({
        id: 'bad',
        type: 'agent',
        prompt: 'Do something',
        role: '',
      }),
    ).toThrow();
  });
});

describe('WorkflowSubjects.resolveRole', () => {
  it('exposes the resolveRole subject', () => {
    expect(WorkflowSubjects.resolveRole.subject).toBe('resolveRole');
  });
});

describe('WorkflowResolvedRoleSchema', () => {
  it('parses a minimal resolved role (adapterName only)', () => {
    const role = WorkflowResolvedRoleSchema.parse({ adapterName: 'claudeCode' });
    expect(role.adapterName).toBe('claudeCode');
    expect(role.model).toBeUndefined();
    expect(role.harnessId).toBeUndefined();
    expect(role.systemPrompt).toBeUndefined();
    expect(role.contextMode).toBeUndefined();
    expect(role.providerContext).toBeUndefined();
  });

  it('parses a fully populated resolved role', () => {
    const role = WorkflowResolvedRoleSchema.parse({
      adapterName: 'openai',
      model: 'gpt-4',
      harnessId: 'harness-reviewer',
      systemPrompt: 'You are a code reviewer',
      contextMode: 'fresh',
      providerContext: {
        providerConfigId: 'pc-1',
        definitionId: 'openai',
        credentialRefs: { apiKey: 'env:OPENAI_API_KEY' },
      },
    });
    expect(role.adapterName).toBe('openai');
    expect(role.model).toBe('gpt-4');
    expect(role.harnessId).toBe('harness-reviewer');
    expect(role.systemPrompt).toBe('You are a code reviewer');
    expect(role.contextMode).toBe('fresh');
    expect(role.providerContext?.providerConfigId).toBe('pc-1');
  });

  it('rejects a resolved role without adapterName', () => {
    expect(() => WorkflowResolvedRoleSchema.parse({ model: 'gpt-4' })).toThrow();
  });

  it('rejects a resolved role with empty adapterName', () => {
    expect(() => WorkflowResolvedRoleSchema.parse({ adapterName: '' })).toThrow();
  });
});

describe('ExecutableStepStateSchema', () => {
  it('parses a minimal executable state', () => {
    const state = ExecutableStepStateSchema.parse({ kind: 'executable', status: 'pending' });
    expect(state).toMatchObject({ kind: 'executable', status: 'pending' });
  });

  it('parses a complete executable state', () => {
    const state = ExecutableStepStateSchema.parse({
      kind: 'executable',
      status: 'completed',
      result: 'done',
      subagentId: 'sa-123',
      sessionId: 'sess-456',
      startedAt: 1000,
      completedAt: 2000,
    });
    expect(state.result).toBe('done');
    expect(state.subagentId).toBe('sa-123');
    expect(state.startedAt).toBe(1000);
  });

  it('rejects state without kind', () => {
    expect(() => ExecutableStepStateSchema.parse({ status: 'pending' })).toThrow();
  });

  it('rejects composite kind', () => {
    expect(() => ExecutableStepStateSchema.parse({ kind: 'composite', status: 'pending' })).toThrow();
  });
});

describe('CompositeStepStateSchema', () => {
  it('parses a minimal composite state', () => {
    const state = CompositeStepStateSchema.parse({ kind: 'composite', status: 'pending' });
    expect(state).toMatchObject({ kind: 'composite', status: 'pending' });
  });

  it('parses a composite state with expansion', () => {
    const state = CompositeStepStateSchema.parse({
      kind: 'composite',
      status: 'expanding',
      startedAt: 1000,
      expansion: {
        parentStepId: 'loop',
        childSteps: [],
        stepContext: {},
        leafStepIds: [],
      },
    });
    expect(state.expansion?.parentStepId).toBe('loop');
    expect(state.status).toBe('expanding');
  });

  it('accepts cancelled status', () => {
    const state = CompositeStepStateSchema.parse({ kind: 'composite', status: 'cancelled' });
    expect(state.status).toBe('cancelled');
  });

  it('rejects executable statuses not in the composite enum (e.g. running)', () => {
    expect(() => CompositeStepStateSchema.parse({ kind: 'composite', status: 'running' })).toThrow();
  });

  it('rejects executable kind', () => {
    expect(() => CompositeStepStateSchema.parse({ kind: 'executable', status: 'pending' })).toThrow();
  });
});

describe('StepStateSchema (discriminated union)', () => {
  it('parses executable state via discriminated union', () => {
    const state = StepStateSchema.parse({ kind: 'executable', status: 'running' });
    expect(state.kind).toBe('executable');
    expect(state.status).toBe('running');
  });

  it('parses composite state via discriminated union', () => {
    const state = StepStateSchema.parse({ kind: 'composite', status: 'completed' });
    expect(state.kind).toBe('composite');
    expect(state.status).toBe('completed');
  });

  it('rejects state with unknown kind', () => {
    expect(() => StepStateSchema.parse({ kind: 'unknown', status: 'pending' })).toThrow();
  });

  it('rejects state without kind', () => {
    expect(() => StepStateSchema.parse({ status: 'pending' })).toThrow();
  });
});

describe('ForEachExpansionSnapshotSchema', () => {
  const minimalChildStep = {
    id: 'loop.0.test',
    type: 'agent',
    prompt: 'Test',
  };

  it('parses a minimal snapshot', () => {
    const snapshot = ForEachExpansionSnapshotSchema.parse({
      parentStepId: 'loop',
      childSteps: [],
      stepContext: {},
      leafStepIds: [],
    });
    expect(snapshot.parentStepId).toBe('loop');
    expect(snapshot.childSteps).toHaveLength(0);
    expect(snapshot.leafStepIds).toHaveLength(0);
  });

  it('parses a snapshot with child steps and context', () => {
    const snapshot = ForEachExpansionSnapshotSchema.parse({
      parentStepId: 'loop',
      childSteps: [minimalChildStep],
      stepContext: {
        'loop.0.test': { item: { name: 'a' }, index: 0 },
      },
      leafStepIds: ['loop.0.test'],
    });

    expect(snapshot.childSteps).toHaveLength(1);
    expect(snapshot.stepContext['loop.0.test']).toMatchObject({ item: { name: 'a' }, index: 0 });
    expect(snapshot.leafStepIds).toContain('loop.0.test');
  });

  it('accepts any unknown value as item in stepContext', () => {
    const snapshot = ForEachExpansionSnapshotSchema.parse({
      parentStepId: 'loop',
      childSteps: [],
      stepContext: {
        'loop.0.test': { item: null, index: 0 },
        'loop.1.test': { item: [1, 2, 3], index: 1 },
      },
      leafStepIds: [],
    });
    expect(snapshot.stepContext['loop.0.test']?.item).toBeNull();
    expect(snapshot.stepContext['loop.1.test']?.item).toEqual([1, 2, 3]);
  });

  it('validates childSteps as WorkflowStep schemas', () => {
    // A valid shell step inside childSteps
    const snapshot = ForEachExpansionSnapshotSchema.parse({
      parentStepId: 'loop',
      childSteps: [{ id: 'loop.0.run', type: 'shell', command: ['echo', 'hi'] }],
      stepContext: { 'loop.0.run': { item: 'hi', index: 0 } },
      leafStepIds: ['loop.0.run'],
    });
    const child = snapshot.childSteps[0];
    expect(child).toMatchObject({ id: 'loop.0.run', type: 'shell' });
  });

  it('rejects childSteps with an invalid step type', () => {
    expect(() =>
      ForEachExpansionSnapshotSchema.parse({
        parentStepId: 'loop',
        childSteps: [{ id: 'loop.0.bad', type: 'invalid-type' }],
        stepContext: {},
        leafStepIds: [],
      }),
    ).toThrow();
  });
});

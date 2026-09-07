import { describe, expect, it } from 'vitest';
import {
  ExecutionAttemptInstructionSchema,
  ExecutionAttemptOutcomeSchema,
  WorkspaceRequirementSchema,
} from '../index.js';

const scratch = { provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] };
const instruction = {
  id: 'instruction-1',
  revision: '1',
  workload: { kind: 'example', version: '1', input: { value: 42 } },
  preservation: { required: [] },
};

describe('ExecutionAttemptInstruction', () => {
  it('supports a workspace-less workload and explicit scratch preservation', () => {
    expect(ExecutionAttemptInstructionSchema.parse(instruction)).toStrictEqual(instruction);
  });

  it('supports a scratch workspace with zero source roots', () => {
    expect(ExecutionAttemptInstructionSchema.parse({ ...instruction, workspace: scratch }).workspace).toStrictEqual(
      scratch,
    );
  });

  it('requires explicit identity, adapter version and preservation requirements', () => {
    for (const field of ['id', 'revision', 'preservation'] as const) {
      const candidate = { ...instruction, [field]: undefined };
      expect(ExecutionAttemptInstructionSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      ExecutionAttemptInstructionSchema.safeParse({
        ...instruction,
        workload: { kind: 'example', input: {} },
      }).success,
    ).toBe(false);
  });

  it('keeps provisioning and custody independent', () => {
    for (const provisioning of ['bind', 'create']) {
      for (const custody of ['external', 'disposable']) {
        expect(WorkspaceRequirementSchema.parse({ ...scratch, provisioning, custody })).toMatchObject({
          provisioning,
          custody,
        });
      }
    }
  });

  it('retains the multi-root contract seam without implementing it', () => {
    expect(
      WorkspaceRequirementSchema.parse({
        ...scratch,
        sourceRoots: [
          { id: 'a', path: 'a' },
          { id: 'b', path: 'b' },
        ],
      }).sourceRoots,
    ).toHaveLength(2);
  });

  it.each([
    '../outside',
    '/absolute',
    'C:/absolute',
    'nested/../../outside',
    '\\outside',
  ])('rejects a source placement outside the workspace: %s', (path) => {
    expect(
      WorkspaceRequirementSchema.safeParse({
        ...scratch,
        sourceRoots: [{ id: 'source', path }],
      }).success,
    ).toBe(false);
  });

  it('allows the workspace root itself as source placement', () => {
    expect(
      WorkspaceRequirementSchema.parse({
        ...scratch,
        sourceRoots: [{ id: 'primary', path: '.' }],
      }).sourceRoots[0]?.path,
    ).toBe('.');
  });

  it('rejects worker-local binding fields inside a portable workspace requirement', () => {
    expect(WorkspaceRequirementSchema.safeParse({ ...scratch, workspaceRoot: '/work/attempt-1' }).success).toBe(false);
  });

  it('accepts explicit commands without shell parsing or a new grant model', () => {
    const setup = [{ command: 'node', args: ['setup.js'], env: { MODE: 'test' }, timeoutMs: 1000 }];
    expect(WorkspaceRequirementSchema.parse({ ...scratch, setup }).setup).toStrictEqual(setup);
  });

  it('rejects non-JSON workload input', () => {
    expect(
      ExecutionAttemptInstructionSchema.safeParse({
        ...instruction,
        workload: { ...instruction.workload, input: { callback: () => undefined } },
      }).success,
    ).toBe(false);
  });
});

describe('ExecutionAttemptOutcome cancellation', () => {
  it('reports stopped cooperative work with an optional reason', () => {
    expect(ExecutionAttemptOutcomeSchema.parse({ kind: 'cancelled' })).toStrictEqual({ kind: 'cancelled' });
    expect(ExecutionAttemptOutcomeSchema.parse({ kind: 'cancelled', reason: 'Stopped during setup' })).toStrictEqual({
      kind: 'cancelled',
      reason: 'Stopped during setup',
    });
  });

  it('keeps optional cancellation diagnostics nonempty and bounded', () => {
    expect(ExecutionAttemptOutcomeSchema.safeParse({ kind: 'cancelled', reason: '' }).success).toBe(false);
    expect(ExecutionAttemptOutcomeSchema.safeParse({ kind: 'cancelled', reason: 'x'.repeat(8192) }).success).toBe(true);
    expect(ExecutionAttemptOutcomeSchema.safeParse({ kind: 'cancelled', reason: 'x'.repeat(8193) }).success).toBe(
      false,
    );
  });

  it('does not accept a cancellation intent or workflow result fields as a runtime outcome', () => {
    expect(ExecutionAttemptOutcomeSchema.safeParse({ kind: 'cancel-requested' }).success).toBe(false);
    expect(ExecutionAttemptOutcomeSchema.safeParse({ kind: 'cancelled', status: 'cancelled' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { LoopCheckOutputSchema, WorkflowDefinitionSchema, WorkflowLoopNodeSchema } from '../schemas.js';

const loopWithoutCheck = {
  id: 'rounds',
  type: 'loop',
  maxRounds: 2,
  body: { id: 'body', type: 'sequence', nodes: [{ id: 'review', type: 'code-step' }] },
};
const check = 'review';

describe('workflow loop check', () => {
  it('requires a check', () => {
    expect(WorkflowLoopNodeSchema.safeParse(loopWithoutCheck).success).toBe(false);
    expect(WorkflowLoopNodeSchema.safeParse({ ...loopWithoutCheck, check }).success).toBe(true);
  });

  it.each(['fail', 'complete'])('accepts %s as the loop exhaustion policy', (onExhausted) => {
    expect(WorkflowLoopNodeSchema.parse({ ...loopWithoutCheck, check, onExhausted }).onExhausted).toBe(onExhausted);
  });

  it('leaves the policy optional and rejects unknown policies', () => {
    expect(WorkflowLoopNodeSchema.parse({ ...loopWithoutCheck, check }).onExhausted).toBeUndefined();
    expect(WorkflowLoopNodeSchema.safeParse({ ...loopWithoutCheck, check, onExhausted: 'skip' }).success).toBe(false);
  });

  it('rejects the retired loop field with or without a valid check', () => {
    const legacy = { gate: check }; // legacy-input
    expect(WorkflowLoopNodeSchema.safeParse({ ...loopWithoutCheck, ...legacy }).success).toBe(false);

    const result = WorkflowLoopNodeSchema.safeParse({ ...loopWithoutCheck, check, ...legacy });
    expect(result.error?.issues).toContainEqual(expect.objectContaining({ keys: ['gate'] })); // legacy-input
  });

  it('rejects escalation on a check', () => {
    const legacyCheck = { handler: check, escalation: { prompt: 'Review' } }; // legacy-input
    expect(WorkflowLoopNodeSchema.safeParse({ ...loopWithoutCheck, check: legacyCheck }).success).toBe(false);
  });

  it('rejects a definition with the retired node type', () => {
    const retiredNode = { id: 'review', type: 'gate' }; // legacy-input
    const root = { id: 'root', type: 'sequence', nodes: [retiredNode] };
    expect(WorkflowDefinitionSchema.safeParse({ id: 'test', name: 'Test', root }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ id: 'test', name: 'Test', root: { ...root, nodes: [] } }).success).toBe(
      true,
    );
  });

  it('requires the check to name a step within the loop body', () => {
    const result = WorkflowLoopNodeSchema.safeParse({ ...loopWithoutCheck, check: 'outside' });
    expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ['check'] }));
    expect(WorkflowLoopNodeSchema.safeParse({ ...loopWithoutCheck, check: { handler: 'review' } }).success).toBe(false);
  });

  it.each(['iterate', 'iterate-chain'])('rejects a convergence step inside %s', (type) => {
    const body = {
      id: 'body',
      type: 'sequence',
      nodes: [{ id: 'items', type, collection: 'inputs.items', body: loopWithoutCheck.body }],
    };
    const result = WorkflowLoopNodeSchema.safeParse({ ...loopWithoutCheck, body, check });
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['check'],
        params: { code: 'WORKFLOW_LOOP_CHECK_MULTIPLE' },
      }),
    );
  });

  it('requires a boolean done result', () => {
    expect(LoopCheckOutputSchema.parse({ done: false })).toEqual({ done: false });
    expect(LoopCheckOutputSchema.parse({ done: true })).toEqual({ done: true });
    expect(LoopCheckOutputSchema.safeParse({ kind: 'pass' }).success).toBe(false);
  });
});

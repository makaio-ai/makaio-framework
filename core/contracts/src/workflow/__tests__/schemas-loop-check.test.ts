import { describe, expect, it } from 'vitest';
import { LoopCheckOutcomeSchema, WorkflowDefinitionSchema, WorkflowLoopNodeSchema } from '../schemas.js';

const loopWithoutCheck = {
  id: 'rounds',
  type: 'loop',
  maxRounds: 2,
  body: { id: 'body', type: 'sequence', nodes: [] },
};
const check = { handler: 'review' };

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
    const legacyCheck = { ...check, escalation: { prompt: 'Review' } }; // legacy-input
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

  it('accepts only pass and loop outcomes', () => {
    expect(LoopCheckOutcomeSchema.options.map((variant) => variant.shape.kind.value)).toEqual(['pass', 'loop']);
    expect(LoopCheckOutcomeSchema.safeParse({ kind: 'escalate' }).success).toBe(false); // legacy-input
  });
});

import { describe, it, expect } from 'vitest';
import { expandForEachSteps } from '../for-each-expander.js';
import type { WorkflowStep, ForEachWorkflowStep } from '@makaio/contracts';
import type { ExpressionContext } from '@makaio/expression';

/** Minimal expression context for tests that don't need step results. */
const baseContext: ExpressionContext = {
  trigger: {},
  steps: {},
  inputs: {},
};

/**
 * Build a context with a resolved collection variable.
 * @param name - The trigger field name
 * @param value - The value to assign to that field
 */
function contextWithVar(name: string, value: unknown): ExpressionContext {
  return { ...baseContext, trigger: { [name]: value } };
}

describe('expandForEachSteps', () => {
  describe('simple for-each with 1 inner step', () => {
    it('produces one expanded step per collection item with namespaced IDs', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process item' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result, stepContext } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b']));

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'loop.0.process', type: 'agent' });
      expect(result[1]).toMatchObject({ id: 'loop.1.process', type: 'agent' });

      expect(stepContext.get('loop.0.process')).toEqual({ item: 'a', index: 0 });
      expect(stepContext.get('loop.1.process')).toEqual({ item: 'b', index: 1 });
    });

    it('returns empty steps for an empty collection', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process item' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result, stepContext } = expandForEachSteps(steps, contextWithVar('items', []));

      expect(result).toHaveLength(0);
      expect(stepContext.size).toBe(0);
    });
  });

  describe('for-each with inner DAG (2 inner steps with needs)', () => {
    it('namespaces inner needs correctly per iteration', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [
            { id: 'fetch', type: 'shell', command: ['fetch', '{{item}}'] },
            { id: 'process', type: 'agent', prompt: 'Process', needs: ['fetch'] },
          ],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', ['x', 'y']));

      expect(result).toHaveLength(4);

      // Iteration 0
      const fetch0 = result.find((s) => s.id === 'loop.0.fetch');
      const process0 = result.find((s) => s.id === 'loop.0.process');
      expect(fetch0?.needs).toBeUndefined();
      expect(process0?.needs).toEqual(['loop.0.fetch']);

      // Iteration 1
      const fetch1 = result.find((s) => s.id === 'loop.1.fetch');
      const process1 = result.find((s) => s.id === 'loop.1.process');
      expect(fetch1?.needs).toBeUndefined();
      expect(process1?.needs).toEqual(['loop.1.fetch']);
    });
  });

  describe('for-each with upstream dependency (for-each itself has needs)', () => {
    it('root inner steps inherit the for-each needs', () => {
      const steps: WorkflowStep[] = [
        { id: 'setup', type: 'agent', prompt: 'Setup' },
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          needs: ['setup'],
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b']));

      // setup stays unchanged
      expect(result.find((s) => s.id === 'setup')).toBeDefined();

      // Both iterations' root steps depend on 'setup'
      expect(result.find((s) => s.id === 'loop.0.process')?.needs).toEqual(['setup']);
      expect(result.find((s) => s.id === 'loop.1.process')?.needs).toEqual(['setup']);
    });
  });

  describe('downstream dependency on a for-each step', () => {
    it('rewires downstream step needs to expanded leaf IDs', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
        { id: 'aggregate', type: 'agent', prompt: 'Aggregate', needs: ['loop'] },
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b']));

      const aggregate = result.find((s) => s.id === 'aggregate');
      expect(aggregate?.needs).toEqual(['loop.0.process', 'loop.1.process']);
    });

    it('downstream step has empty needs when for-each collection is empty', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
        { id: 'aggregate', type: 'agent', prompt: 'Aggregate', needs: ['loop'] },
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', []));

      // loop expands to nothing; aggregate's needs should be cleared (no deps)
      const aggregate = result.find((s) => s.id === 'aggregate');
      expect(aggregate?.needs).toBeUndefined();
    });
  });

  describe('concurrency batching', () => {
    it('adds batch dependency edges between batches when concurrency is set', () => {
      // 3 items, concurrency: 2 → batch 0 = [0,1], batch 1 = [2]
      // iteration 2 root step must depend on leaf IDs of batch 0
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          concurrency: 2,
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', [1, 2, 3]));

      expect(result).toHaveLength(3);

      // Items 0 and 1 are in batch 0 - no concurrency deps
      const process0 = result.find((s) => s.id === 'loop.0.process');
      const process1 = result.find((s) => s.id === 'loop.1.process');
      expect(process0?.needs).toBeUndefined();
      expect(process1?.needs).toBeUndefined();

      // Item 2 starts batch 1 — must wait for leaf IDs of batch 0
      const process2 = result.find((s) => s.id === 'loop.2.process');
      // The leaf of batch 0 is the last item's leaf: loop.1.process
      expect(process2?.needs).toContain('loop.1.process');
    });

    it('blocks the next batch on all leaf steps from the previous batch', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          concurrency: 2,
          steps: [
            { id: 'a', type: 'agent', prompt: 'A' },
            { id: 'b', type: 'agent', prompt: 'B' },
          ],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', [1, 2, 3]));
      const batch1Root = result.find((s) => s.id === 'loop.2.a');
      expect(batch1Root?.needs).toEqual(expect.arrayContaining(['loop.0.a', 'loop.0.b', 'loop.1.a', 'loop.1.b']));
    });
  });

  describe('if condition on inner steps is preserved', () => {
    it('preserves if expression on expanded inner steps', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'conditional', type: 'agent', prompt: 'Maybe run', if: 'index > 0' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b']));

      expect(result.find((s) => s.id === 'loop.0.conditional')?.if).toBe('index > 0');
      expect(result.find((s) => s.id === 'loop.1.conditional')?.if).toBe('index > 0');
    });
  });

  describe('if condition on for-each step itself', () => {
    it('skips expansion when for-each if evaluates to false', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          if: 'false',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result, stepContext } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b']));

      expect(result).toHaveLength(0);
      expect(stepContext.size).toBe(0);
    });

    it('expands normally when for-each if evaluates to true', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          if: 'true',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b']));

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'loop.0.process' });
      expect(result[1]).toMatchObject({ id: 'loop.1.process' });
    });

    it('treats empty-string if as no condition (expands normally)', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          if: '',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b']));

      // Empty string if is treated as "no condition" — consistent with executor semantics
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'loop.0.process' });
      expect(result[1]).toMatchObject({ id: 'loop.1.process' });
    });

    it('rewires downstream needs to empty when for-each is skipped via if', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          if: 'false',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
        { id: 'aggregate', type: 'agent', prompt: 'Aggregate', needs: ['loop'] },
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b']));

      // Only aggregate remains, with needs cleared (same as empty collection case)
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'aggregate' });
      expect(result[0].needs).toBeUndefined();
    });
  });

  describe('concurrency: 1 (fully sequential)', () => {
    it('forces each iteration to wait for the previous one', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          concurrency: 1,
          steps: [{ id: 'process', type: 'agent', prompt: 'Process' }],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result } = expandForEachSteps(steps, contextWithVar('items', ['a', 'b', 'c']));

      expect(result).toHaveLength(3);

      // Iteration 0: no deps (first batch)
      const process0 = result.find((s) => s.id === 'loop.0.process');
      expect(process0?.needs).toBeUndefined();

      // Iteration 1: depends on iteration 0's leaf
      const process1 = result.find((s) => s.id === 'loop.1.process');
      expect(process1?.needs).toEqual(['loop.0.process']);

      // Iteration 2: depends on iteration 1's leaf
      const process2 = result.find((s) => s.id === 'loop.2.process');
      expect(process2?.needs).toEqual(['loop.1.process']);
    });
  });

  describe('non-array collection throws', () => {
    it('throws when collection expression resolves to a string', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process item' }],
        } satisfies ForEachWorkflowStep,
      ];

      expect(() => expandForEachSteps(steps, contextWithVar('items', 'not-an-array'))).toThrow(
        "for-each step 'loop': collection expression did not resolve to an array (got string)",
      );
    });

    it('throws when collection expression resolves to null', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process item' }],
        } satisfies ForEachWorkflowStep,
      ];

      expect(() => expandForEachSteps(steps, contextWithVar('items', null))).toThrow(
        "for-each step 'loop': collection expression did not resolve to an array (got object)",
      );
    });

    it('throws when for-each id contains dot', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop.v1',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'process', type: 'agent', prompt: 'Process item' }],
        } satisfies ForEachWorkflowStep,
      ];

      expect(() => expandForEachSteps(steps, contextWithVar('items', ['x']))).toThrow(
        "for-each step 'loop.v1': id cannot contain '.'",
      );
    });

    it('throws when inner step id contains dot', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'loop',
          type: 'for-each',
          collection: 'trigger.items',
          steps: [{ id: 'process.v1', type: 'agent', prompt: 'Process item' }],
        } satisfies ForEachWorkflowStep,
      ];

      expect(() => expandForEachSteps(steps, contextWithVar('items', ['x']))).toThrow(
        "for-each step 'loop': inner step id 'process.v1' cannot contain '.'",
      );
    });
  });

  describe('non-for-each steps pass through unchanged', () => {
    it('leaves agent/shell/gate steps untouched', () => {
      const agentStep: WorkflowStep = { id: 'agent', type: 'agent', prompt: 'Do work' };
      const shellStep: WorkflowStep = { id: 'shell', type: 'shell', command: ['echo', 'hi'] };

      const { steps: result } = expandForEachSteps([agentStep, shellStep], baseContext);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe(agentStep);
      expect(result[1]).toBe(shellStep);
    });
  });

  describe('nested for-each', () => {
    it('recursively expands nested for-each steps', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'outer',
          type: 'for-each',
          collection: 'trigger.outer',
          steps: [
            {
              id: 'inner',
              type: 'for-each',
              collection: 'trigger.inner',
              steps: [{ id: 'leaf', type: 'agent', prompt: 'Leaf' }],
            } satisfies ForEachWorkflowStep,
          ],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result, stepContext } = expandForEachSteps(steps, {
        ...baseContext,
        trigger: { outer: ['A', 'B'], inner: ['x', 'y'] },
      });

      // outer has 2 iterations, inner has 2 each → 4 total leaf steps
      expect(result).toHaveLength(4);

      // IDs are double-namespaced: outer.{oi}.inner.{ii}.leaf
      expect(result.some((s) => s.id === 'outer.0.inner.0.leaf')).toBe(true);
      expect(result.some((s) => s.id === 'outer.0.inner.1.leaf')).toBe(true);
      expect(result.some((s) => s.id === 'outer.1.inner.0.leaf')).toBe(true);
      expect(result.some((s) => s.id === 'outer.1.inner.1.leaf')).toBe(true);

      expect(stepContext.get('outer.0.inner.0.leaf')).toEqual({ item: 'x', index: 0 });
      expect(stepContext.get('outer.0.inner.1.leaf')).toEqual({ item: 'y', index: 1 });
      expect(stepContext.get('outer.1.inner.0.leaf')).toEqual({ item: 'x', index: 0 });
      expect(stepContext.get('outer.1.inner.1.leaf')).toEqual({ item: 'y', index: 1 });
    });

    it('evaluates nested collections with the outer item and index in scope', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'outer',
          type: 'for-each',
          collection: 'trigger.parents',
          steps: [
            {
              id: 'inner',
              type: 'for-each',
              collection: 'item.childrenByOuterIndex[index]',
              steps: [{ id: 'leaf', type: 'agent', prompt: 'Leaf' }],
            } satisfies ForEachWorkflowStep,
          ],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result, stepContext } = expandForEachSteps(steps, {
        ...baseContext,
        trigger: {
          parents: [
            { childrenByOuterIndex: [['outer-0-child'], ['wrong-index']] },
            { childrenByOuterIndex: [['wrong-index'], ['outer-1-child-a', 'outer-1-child-b']] },
          ],
        },
      });

      expect(result.map((step) => step.id)).toEqual([
        'outer.0.inner.0.leaf',
        'outer.1.inner.0.leaf',
        'outer.1.inner.1.leaf',
      ]);
      expect(stepContext.get('outer.0.inner.0.leaf')).toEqual({ item: 'outer-0-child', index: 0 });
      expect(stepContext.get('outer.1.inner.0.leaf')).toEqual({ item: 'outer-1-child-a', index: 0 });
      expect(stepContext.get('outer.1.inner.1.leaf')).toEqual({ item: 'outer-1-child-b', index: 1 });
    });

    it('does not leak inner stepContext when outer collection is empty', () => {
      const steps: WorkflowStep[] = [
        {
          id: 'outer',
          type: 'for-each',
          collection: 'trigger.outer',
          steps: [
            {
              id: 'inner',
              type: 'for-each',
              collection: 'trigger.inner',
              steps: [{ id: 'leaf', type: 'agent', prompt: 'Leaf' }],
            } satisfies ForEachWorkflowStep,
          ],
        } satisfies ForEachWorkflowStep,
      ];

      const { steps: result, stepContext } = expandForEachSteps(steps, {
        ...baseContext,
        trigger: { outer: [], inner: ['x'] },
      });

      expect(result).toHaveLength(0);
      expect(stepContext.size).toBe(0);
    });
  });
});

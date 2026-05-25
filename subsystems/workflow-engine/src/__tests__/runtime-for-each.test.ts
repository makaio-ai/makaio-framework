import { describe, it, expect } from 'vitest';
import { buildForEachExpansionSnapshot, expandForEachAtRuntime } from '../runtime-for-each.js';
import type { ForEachWorkflowStep } from '@makaio/contracts';
import type { WorkflowExpressionContext } from '@makaio/expression';

/** Minimal expression context for tests that don't need step results or triggers. */
const expressionContext: WorkflowExpressionContext = {
  trigger: {},
  steps: {},
  inputs: {},
};

/** A simple for-each step with one inner step. */
const forEachStep: ForEachWorkflowStep = {
  id: 'process',
  type: 'for-each',
  collection: 'trigger.items',
  steps: [{ id: 'test', type: 'agent', prompt: 'Process {{ item.name }}' }],
};

describe('buildForEachExpansionSnapshot', () => {
  describe('deterministic child IDs and leaf IDs', () => {
    it('creates deterministic child ids and leaf ids', () => {
      const snapshot = buildForEachExpansionSnapshot({
        parent: forEachStep,
        collection: [{ name: 'a' }, { name: 'b' }],
        expressionContext,
      });

      expect(snapshot.childSteps.map((step) => step.id)).toEqual(['process.0.test', 'process.1.test']);
      expect(snapshot.leafStepIds).toEqual(['process.0.test', 'process.1.test']);
    });

    it('sets parentStepId to the for-each step id', () => {
      const snapshot = buildForEachExpansionSnapshot({
        parent: forEachStep,
        collection: ['x'],
        expressionContext,
      });

      expect(snapshot.parentStepId).toBe('process');
    });
  });

  describe('stepContext mapping', () => {
    it('records item and index for each child step', () => {
      const snapshot = buildForEachExpansionSnapshot({
        parent: forEachStep,
        collection: [{ name: 'a' }, { name: 'b' }],
        expressionContext,
      });

      expect(snapshot.stepContext['process.0.test']).toEqual({ item: { name: 'a' }, index: 0 });
      expect(snapshot.stepContext['process.1.test']).toEqual({ item: { name: 'b' }, index: 1 });
    });

    it('covers all child step IDs in stepContext', () => {
      const snapshot = buildForEachExpansionSnapshot({
        parent: forEachStep,
        collection: ['a', 'b', 'c'],
        expressionContext,
      });

      const contextKeys = Object.keys(snapshot.stepContext).sort();
      const childIds = snapshot.childSteps.map((s) => s.id).sort();
      expect(contextKeys).toEqual(childIds);
    });
  });

  describe('empty collection', () => {
    it('returns empty snapshot for an empty collection', () => {
      const snapshot = buildForEachExpansionSnapshot({
        parent: forEachStep,
        collection: [],
        expressionContext,
      });

      expect(snapshot.childSteps).toHaveLength(0);
      expect(snapshot.leafStepIds).toHaveLength(0);
      expect(snapshot.stepContext).toEqual({});
      expect(snapshot.parentStepId).toBe('process');
    });
  });

  describe('concurrency batching', () => {
    it('adds previous batch leaves as needs for the next batch roots', () => {
      const snapshot = buildForEachExpansionSnapshot({
        parent: { ...forEachStep, concurrency: 1 },
        collection: ['a', 'b'],
        expressionContext,
      });

      // With concurrency: 1, iteration 1 must wait for iteration 0.
      const step1 = snapshot.childSteps.find((s) => s.id === 'process.1.test');
      expect(step1?.needs).toContain('process.0.test');
    });

    it('first batch has no concurrency needs', () => {
      const snapshot = buildForEachExpansionSnapshot({
        parent: { ...forEachStep, concurrency: 1 },
        collection: ['a', 'b'],
        expressionContext,
      });

      const step0 = snapshot.childSteps.find((s) => s.id === 'process.0.test');
      // First iteration should have no needs (no previous batch).
      expect(step0?.needs).toBeUndefined();
    });

    it('second batch root depends on all leaf IDs from the first batch', () => {
      // 4 items, concurrency: 2 → batch 0 = [0,1], batch 1 = [2,3]
      const multiInnerStep: ForEachWorkflowStep = {
        id: 'process',
        type: 'for-each',
        collection: 'trigger.items',
        concurrency: 2,
        steps: [
          { id: 'a', type: 'agent', prompt: 'A' },
          { id: 'b', type: 'agent', prompt: 'B' },
        ],
      };

      const snapshot = buildForEachExpansionSnapshot({
        parent: multiInnerStep,
        collection: [1, 2, 3, 4],
        expressionContext,
      });

      const firstBatch1Root = snapshot.childSteps.find((s) => s.id === 'process.2.a');
      const secondBatch1Root = snapshot.childSteps.find((s) => s.id === 'process.3.a');
      // Must depend on all leaves from batch 0 (process.0.a, process.0.b, process.1.a, process.1.b)
      expect(firstBatch1Root?.needs).toEqual(
        expect.arrayContaining(['process.0.a', 'process.0.b', 'process.1.a', 'process.1.b']),
      );
      expect(secondBatch1Root?.needs).toEqual(
        expect.arrayContaining(['process.0.a', 'process.0.b', 'process.1.a', 'process.1.b']),
      );
    });
  });

  describe('multi-step inner DAG', () => {
    it('namespaces inner needs per iteration', () => {
      const dagStep: ForEachWorkflowStep = {
        id: 'loop',
        type: 'for-each',
        collection: 'trigger.items',
        steps: [
          { id: 'fetch', type: 'shell', command: ['fetch'] },
          { id: 'process', type: 'agent', prompt: 'Process', needs: ['fetch'] },
        ],
      };

      const snapshot = buildForEachExpansionSnapshot({
        parent: dagStep,
        collection: ['x', 'y'],
        expressionContext,
      });

      const process0 = snapshot.childSteps.find((s) => s.id === 'loop.0.process');
      const process1 = snapshot.childSteps.find((s) => s.id === 'loop.1.process');
      expect(process0?.needs).toEqual(['loop.0.fetch']);
      expect(process1?.needs).toEqual(['loop.1.fetch']);
    });

    it('identifies only leaf steps (not depended on by siblings)', () => {
      const dagStep: ForEachWorkflowStep = {
        id: 'loop',
        type: 'for-each',
        collection: 'trigger.items',
        steps: [
          { id: 'fetch', type: 'shell', command: ['fetch'] },
          { id: 'process', type: 'agent', prompt: 'Process', needs: ['fetch'] },
        ],
      };

      const snapshot = buildForEachExpansionSnapshot({
        parent: dagStep,
        collection: ['x', 'y'],
        expressionContext,
      });

      // Only 'process' steps are leaves (fetch is depended on by process)
      expect(snapshot.leafStepIds.sort()).toEqual(['loop.0.process', 'loop.1.process']);
    });
  });

  describe('parent for-each needs propagation', () => {
    it('propagates parent for-each needs to root inner steps', () => {
      const stepWithNeeds: ForEachWorkflowStep = {
        ...forEachStep,
        needs: ['setup'],
      };

      const snapshot = buildForEachExpansionSnapshot({
        parent: stepWithNeeds,
        collection: ['a'],
        expressionContext,
      });

      const step0 = snapshot.childSteps.find((s) => s.id === 'process.0.test');
      expect(step0?.needs).toContain('setup');
    });
  });

  describe('nested runtime composites', () => {
    it('keeps direct nested for-each steps as runtime composite children', () => {
      const nestedStep: ForEachWorkflowStep = {
        id: 'outer',
        type: 'for-each',
        collection: 'trigger.items',
        steps: [
          {
            id: 'inner',
            type: 'for-each',
            collection: 'steps.discover.result|parseJson',
            needs: ['discover'],
            steps: [{ id: 'work', type: 'agent', prompt: 'Work {{ item }}' }],
          },
          { id: 'discover', type: 'shell', command: ['echo', '[]'] },
        ],
      };

      const snapshot = buildForEachExpansionSnapshot({
        parent: nestedStep,
        collection: ['outer-item'],
        expressionContext,
      });

      expect(snapshot.childSteps.map((step) => step.id).sort()).toEqual(['outer.0.discover', 'outer.0.inner']);
      expect(snapshot.childSteps.find((step) => step.id === 'outer.0.inner')?.type).toBe('for-each');
      expect(snapshot.childSteps.find((step) => step.id === 'outer.0.inner')?.needs).toEqual(['outer.0.discover']);
      expect(snapshot.leafStepIds).toEqual(['outer.0.inner']);
    });

    it('rejects duplicate direct inner step IDs before expansion', () => {
      const duplicateInner: ForEachWorkflowStep = {
        id: 'process',
        type: 'for-each',
        collection: 'trigger.items',
        steps: [
          { id: 'work', type: 'agent', prompt: 'A' },
          { id: 'work', type: 'agent', prompt: 'B' },
        ],
      };

      expect(() =>
        buildForEachExpansionSnapshot({
          parent: duplicateInner,
          collection: ['x'],
          expressionContext,
        }),
      ).toThrow("Duplicate step ID: 'work'");
    });
  });
});

describe('expandForEachAtRuntime', () => {
  it('evaluates collection expression and delegates to buildForEachExpansionSnapshot', () => {
    const snapshot = expandForEachAtRuntime(forEachStep, {
      ...expressionContext,
      trigger: { items: ['a', 'b'] },
    });

    expect(snapshot.parentStepId).toBe('process');
    expect(snapshot.childSteps).toHaveLength(2);
    expect(snapshot.childSteps[0]?.id).toBe('process.0.test');
    expect(snapshot.childSteps[1]?.id).toBe('process.1.test');
  });

  it('throws when collection expression resolves to a non-array', () => {
    expect(() =>
      expandForEachAtRuntime(forEachStep, {
        ...expressionContext,
        trigger: { items: 'not-an-array' },
      }),
    ).toThrow("for-each step 'process': collection expression did not resolve to an array (got string)");
  });

  it('returns empty snapshot when collection resolves to an empty array', () => {
    const snapshot = expandForEachAtRuntime(forEachStep, {
      ...expressionContext,
      trigger: { items: [] },
    });

    expect(snapshot.childSteps).toHaveLength(0);
    expect(snapshot.leafStepIds).toHaveLength(0);
  });
});

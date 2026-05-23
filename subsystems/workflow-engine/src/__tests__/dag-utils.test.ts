import { describe, it, expect } from 'vitest';
import { topologicalSort, areDependenciesMet, groupByTopoLevel } from '../dag-utils.js';
import type { WorkflowStep, StepState } from '@makaio/contracts';

describe('topologicalSort', () => {
  it('sorts independent steps in definition order', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'agent', prompt: 'A' },
      { id: 'b', type: 'agent', prompt: 'B' },
      { id: 'c', type: 'agent', prompt: 'C' },
    ];
    const result = topologicalSort(steps);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('respects dependencies', () => {
    const steps: WorkflowStep[] = [
      { id: 'c', type: 'agent', prompt: 'C', needs: ['b'] },
      { id: 'a', type: 'agent', prompt: 'A' },
      { id: 'b', type: 'agent', prompt: 'B', needs: ['a'] },
    ];
    const result = topologicalSort(steps);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('c'));
  });

  it('throws on unknown dependency', () => {
    const steps: WorkflowStep[] = [{ id: 'a', type: 'agent', prompt: 'A', needs: ['unknown'] }];
    expect(() => topologicalSort(steps)).toThrow('unknown');
  });

  it('throws on cycle', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'agent', prompt: 'A', needs: ['b'] },
      { id: 'b', type: 'agent', prompt: 'B', needs: ['a'] },
    ];
    expect(() => topologicalSort(steps)).toThrow('Cycle detected');
  });

  it('throws on duplicate step IDs', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'agent', prompt: 'A' },
      { id: 'a', type: 'agent', prompt: 'A duplicate' },
    ];
    expect(() => topologicalSort(steps)).toThrow('Duplicate step ID');
  });
});

describe('groupByTopoLevel', () => {
  it('single step with no deps → one level with one step', () => {
    const steps: WorkflowStep[] = [{ id: 'a', type: 'agent', prompt: 'do A' }];
    expect(groupByTopoLevel(steps)).toEqual([['a']]);
  });

  it('two independent steps → one level with both steps', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'agent', prompt: 'do A' },
      { id: 'b', type: 'agent', prompt: 'do B' },
    ];
    const levels = groupByTopoLevel(steps);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(2);
    expect(levels[0]).toContain('a');
    expect(levels[0]).toContain('b');
  });

  it('diamond (A → B, A → C, B → D, C → D) → three levels', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'agent', prompt: 'do A' },
      { id: 'b', type: 'agent', prompt: 'do B', needs: ['a'] },
      { id: 'c', type: 'agent', prompt: 'do C', needs: ['a'] },
      { id: 'd', type: 'agent', prompt: 'do D', needs: ['b', 'c'] },
    ];
    const levels = groupByTopoLevel(steps);
    expect(levels).toHaveLength(3);
    expect(levels[0]).toEqual(['a']);
    expect(levels[1]).toHaveLength(2);
    expect(levels[1]).toContain('b');
    expect(levels[1]).toContain('c');
    expect(levels[2]).toEqual(['d']);
  });

  it('fan-out (A → B, A → C, A → D) → two levels', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'agent', prompt: 'do A' },
      { id: 'b', type: 'agent', prompt: 'do B', needs: ['a'] },
      { id: 'c', type: 'agent', prompt: 'do C', needs: ['a'] },
      { id: 'd', type: 'agent', prompt: 'do D', needs: ['a'] },
    ];
    const levels = groupByTopoLevel(steps);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toEqual(['a']);
    expect(levels[1]).toHaveLength(3);
  });

  it('cycle detected → throws error', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'agent', prompt: 'do A', needs: ['b'] },
      { id: 'b', type: 'agent', prompt: 'do B', needs: ['a'] },
    ];
    expect(() => groupByTopoLevel(steps)).toThrow(/[Cc]ycle/);
  });

  it('unknown dependency → throws error', () => {
    const steps: WorkflowStep[] = [{ id: 'a', type: 'agent', prompt: 'do A', needs: ['missing'] }];
    expect(() => groupByTopoLevel(steps)).toThrow(/[Uu]nknown/);
  });

  it('throws on duplicate step IDs', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'agent', prompt: 'do A' },
      { id: 'a', type: 'agent', prompt: 'do A duplicate' },
    ];
    expect(() => groupByTopoLevel(steps)).toThrow(/[Dd]uplicate/);
  });

  it('fan-in (two roots converging into one) → two levels', () => {
    const steps: WorkflowStep[] = [
      { id: 'b', type: 'agent', prompt: 'do B' },
      { id: 'c', type: 'agent', prompt: 'do C' },
      { id: 'd', type: 'agent', prompt: 'do D', needs: ['b', 'c'] },
    ];
    const levels = groupByTopoLevel(steps);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toHaveLength(2);
    expect(levels[0]).toContain('b');
    expect(levels[0]).toContain('c');
    expect(levels[1]).toEqual(['d']);
  });
});

describe('areDependenciesMet', () => {
  const steps: WorkflowStep[] = [
    { id: 'a', type: 'agent', prompt: 'A' },
    { id: 'b', type: 'agent', prompt: 'B', needs: ['a'] },
  ];

  it('returns true for step with no dependencies', () => {
    const states: Record<string, StepState> = {};
    expect(areDependenciesMet('a', steps, states)).toBe(true);
  });

  it('returns false when dependency not completed', () => {
    const states: Record<string, StepState> = {
      a: { status: 'running' },
    };
    expect(areDependenciesMet('b', steps, states)).toBe(false);
  });

  it('returns true when dependency completed', () => {
    const states: Record<string, StepState> = {
      a: { status: 'completed' },
    };
    expect(areDependenciesMet('b', steps, states)).toBe(true);
  });

  it('returns true when dependency is skipped', () => {
    const states: Record<string, StepState> = {
      a: { status: 'skipped' },
    };
    expect(areDependenciesMet('b', steps, states)).toBe(true);
  });
});

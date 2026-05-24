import { describe, it, expect } from 'vitest';
import { topologicalSort } from '../dag-utils.js';
import type { WorkflowStep } from '@makaio/contracts';

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

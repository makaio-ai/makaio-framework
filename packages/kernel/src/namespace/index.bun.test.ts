import { afterEach, describe, expect, it } from 'bun:test';
import type { IWorkflowTriggerTypeRegistry } from '@makaio/contracts';
import { getWorkflowTriggerTypeRegistry, setWorkflowTriggerTypeRegistry } from './index.js';

describe('workflow trigger registry state', () => {
  afterEach(() => {
    setWorkflowTriggerTypeRegistry(undefined);
  });

  it('rejects replacing an active registry without clearing first', () => {
    const first = {} as IWorkflowTriggerTypeRegistry;
    const second = {} as IWorkflowTriggerTypeRegistry;

    setWorkflowTriggerTypeRegistry(first);

    expect(() => setWorkflowTriggerTypeRegistry(second)).toThrow(/Workflow trigger type registry is already set/);
    expect(getWorkflowTriggerTypeRegistry()).toBe(first);
  });

  it('allows reusing the same reference and explicit clear-before-replace', () => {
    const first = {} as IWorkflowTriggerTypeRegistry;
    const second = {} as IWorkflowTriggerTypeRegistry;

    expect(() => setWorkflowTriggerTypeRegistry(first)).not.toThrow();
    expect(() => setWorkflowTriggerTypeRegistry(first)).not.toThrow();

    setWorkflowTriggerTypeRegistry(undefined);
    expect(() => setWorkflowTriggerTypeRegistry(second)).not.toThrow();
    expect(getWorkflowTriggerTypeRegistry()).toBe(second);
  });
});

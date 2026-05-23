import { describe, expect, it } from 'vitest';
import type { WorkflowTriggerTypeRecord } from '@makaio/contracts';
import { WorkflowTriggerTypeRegistry } from '../workflow-trigger-type-registry.js';

/**
 * Build a trigger type registry record for cleanup-order tests.
 * @param type - Trigger type string.
 * @param displayName - Human-readable display name.
 * @returns Trigger type registry record.
 */
function createTriggerTypeRecord(type: string, displayName: string): WorkflowTriggerTypeRecord {
  return {
    type,
    displayName,
    icon: 'Zap',
    category: 'Test',
    configJsonSchema: {},
    outputJsonSchema: {},
    source: 'test',
  };
}

describe('WorkflowTriggerTypeRegistry', () => {
  it('does not unregister a newer record for the same trigger type', () => {
    const registry = new WorkflowTriggerTypeRegistry();
    const first = createTriggerTypeRecord('test:event', 'First');
    const second = createTriggerTypeRecord('test:event', 'Second');

    const unregisterFirst = registry.register(first);
    registry.register(second);

    unregisterFirst();

    expect(registry.get('test:event')).toBe(second);
    expect(registry.getAll()).toEqual([second]);
  });
});

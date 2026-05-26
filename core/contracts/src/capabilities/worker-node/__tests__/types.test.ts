import { describe, expect, it } from 'vitest';
import { WORKER_NODE_CAPABILITY_ID, WorkerNodeCapabilitiesSchema } from '../index.js';
import type { WorkerNodeCapabilities, WorkerNodeRequirements } from '../index.js';

describe('worker-node capability contracts', () => {
  it('uses the stable worker-node capability id', () => {
    expect(WORKER_NODE_CAPABILITY_ID).toBe('worker-node');
  });

  it('validates minimal worker-node capabilities', () => {
    const parsed = WorkerNodeCapabilitiesSchema.parse({
      persistentStorage: false,
      customCapabilities: ['workflow.bus-events'],
    });

    expect(parsed).toEqual({
      persistentStorage: false,
      customCapabilities: ['workflow.bus-events'],
    });
  });

  it('allows callers to omit capability arrays that schemas default', () => {
    const capabilities = { persistentStorage: true } satisfies WorkerNodeCapabilities;
    const requirements = { persistentStorage: true } satisfies WorkerNodeRequirements;

    expect(WorkerNodeCapabilitiesSchema.parse(capabilities)).toEqual({
      persistentStorage: true,
      customCapabilities: [],
    });
    expect(requirements).toEqual({ persistentStorage: true });
  });
});

import { describe, expect, expectTypeOf, it } from 'vitest';
import { WORKER_NODE_CAPABILITY_ID, WorkerNodeCapabilitiesSchema } from '../index.js';
import { SuspensionStrategySchema } from '../../../worker-node/suspension.js';
import type { SuspensionStrategy } from '../../../worker-node/suspension.js';
import type { WorkerNodeCapabilitiesInput } from '../types.js';
import type {
  IWorkerNodeProvider,
  WorkerNodeCapabilities,
  WorkerNodeHandle,
  WorkerNodeRequirements,
} from '../index.js';

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
      suspensionStrategy: 'wait-in-process',
    });
  });

  it('allows callers to omit capability arrays that schemas default', () => {
    const capabilities = { persistentStorage: true } satisfies WorkerNodeCapabilitiesInput;
    const requirements = { persistentStorage: true } satisfies WorkerNodeRequirements;

    expect(WorkerNodeCapabilitiesSchema.parse(capabilities)).toEqual({
      persistentStorage: true,
      customCapabilities: [],
      suspensionStrategy: 'wait-in-process',
    });
    expect(requirements).toEqual({ persistentStorage: true });
  });

  it('defaults worker-node suspension to in-process waiting', () => {
    expect(SuspensionStrategySchema.parse('exit-and-redispatch')).toBe('exit-and-redispatch');
    expect(WorkerNodeCapabilitiesSchema.parse({ persistentStorage: true })).toEqual({
      persistentStorage: true,
      customCapabilities: [],
      suspensionStrategy: 'wait-in-process',
    });
  });

  it('requires providers to expose normalized capabilities', () => {
    expectTypeOf<WorkerNodeCapabilities['suspensionStrategy']>().toEqualTypeOf<SuspensionStrategy>();

    const provider: IWorkerNodeProvider = {
      id: 'test.worker-node',
      displayName: 'Test WorkerNode',
      environment: 'test',
      baseCapabilities: WorkerNodeCapabilitiesSchema.parse({ persistentStorage: true }),
      provision: async (): Promise<WorkerNodeHandle> => {
        throw new Error('not used');
      },
    };

    expectTypeOf(provider.baseCapabilities.suspensionStrategy).toEqualTypeOf<SuspensionStrategy>();
    expect(provider.baseCapabilities.suspensionStrategy).toBe('wait-in-process');
  });
});

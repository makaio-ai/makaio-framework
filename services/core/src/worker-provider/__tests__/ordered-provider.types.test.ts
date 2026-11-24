import { expectTypeOf, it } from 'vitest';
import type { OrderedWorkerProvider } from '../ordered-provider.js';

type ProcessBoundProvider = Extract<OrderedWorkerProvider, { allocationLifetime: 'provisioner-process-bound' }>;

it('requires local live proof on a process-bound provider', () => {
  expectTypeOf<Omit<ProcessBoundProvider, 'proveLocalLive'>>().not.toExtend<OrderedWorkerProvider>();
});

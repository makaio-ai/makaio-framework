import type { CoreBootOptions } from '@makaio/runtime-node';
import { readAllocationScopeSetting } from '@makaio/services-core/internal/worker-provider-host-binding';
import { expectTypeOf, it } from 'vitest';

it('accepts only the host inputs for worker dispatch at boot', () => {
  type Options = NonNullable<CoreBootOptions['workerDispatch']>;
  expectTypeOf<keyof Options>().toEqualTypeOf<'source' | 'scopeSetting' | 'connection'>();
});

it('requires a parsed allocation scope for a present boot setting', () => {
  type ScopeSetting = NonNullable<CoreBootOptions['workerDispatch']>['scopeSetting'];
  expectTypeOf<ReturnType<typeof readAllocationScopeSetting>>().toExtend<ScopeSetting>();
  expectTypeOf<{ kind: 'present'; value: 'installation-scope' }>().not.toExtend<ScopeSetting>();
});

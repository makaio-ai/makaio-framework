import { describe, expectTypeOf, it } from 'vitest';
import type { PersistedMachineIdentity } from '@makaio/machine-identity';
import type { ConfigProvider } from '@makaio/providers';
import type { IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';
import type { CoreBootOptions } from '@makaio/runtime-node';

describe('runtime-node boot public surface', () => {
  it('exposes host-provided boot infrastructure seams', () => {
    expectTypeOf<CoreBootOptions>().toHaveProperty('configProvider').toEqualTypeOf<ConfigProvider | undefined>();
    expectTypeOf<CoreBootOptions>()
      .toHaveProperty('adapterConfigRepository')
      .toEqualTypeOf<IAdapterConfigRepository | undefined>();
    expectTypeOf<CoreBootOptions>()
      .toHaveProperty('machineIdentity')
      .toEqualTypeOf<PersistedMachineIdentity | undefined>();
  });
});

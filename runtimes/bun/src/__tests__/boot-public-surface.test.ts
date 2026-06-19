import { describe, expectTypeOf, it } from 'vitest';
import type { PersistedMachineIdentity } from '@makaio/machine-identity';
import type { ConfigProvider } from '@makaio/providers';
import type { CoreBootOptions } from '@makaio/runtime-node';
import type { IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';
import type { BunBootMakaioRuntimeOptions } from '@makaio/runtime-bun';

describe('runtime-bun boot public surface', () => {
  it('inherits shared boot infrastructure seams from CoreBootOptions', () => {
    expectTypeOf<BunBootMakaioRuntimeOptions>().toMatchTypeOf<CoreBootOptions>();
    expectTypeOf<BunBootMakaioRuntimeOptions>()
      .toHaveProperty('configProvider')
      .toEqualTypeOf<ConfigProvider | undefined>();
    expectTypeOf<BunBootMakaioRuntimeOptions>()
      .toHaveProperty('adapterConfigRepository')
      .toEqualTypeOf<IAdapterConfigRepository | undefined>();
    expectTypeOf<BunBootMakaioRuntimeOptions>()
      .toHaveProperty('machineIdentity')
      .toEqualTypeOf<PersistedMachineIdentity | undefined>();
  });
});

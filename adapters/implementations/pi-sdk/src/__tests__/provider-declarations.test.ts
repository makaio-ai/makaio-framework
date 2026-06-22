import { describe, expect, it } from 'vitest';
import { dep } from '@makaio/contracts';
import { adapterDefinition } from '../definition.js';
import { piSdkPackage } from '../package.js';
import { providerIds } from '../provider.js';
import { PiSdkProviderConfigSchema } from '../schemas.js';
import * as publicApi from '../index.js';
import * as testApi from '../test/index.js';

describe('pi-sdk provider declarations', () => {
  it('declares supported providers as subsystem-resolved provider refs', () => {
    expect(adapterDefinition.providers.map(({ definitionId }) => definitionId)).toEqual([...providerIds]);
    expect(adapterDefinition.providerConfigSchema).toBe(PiSdkProviderConfigSchema);

    for (const providerRef of adapterDefinition.providers) {
      expect('definition' in providerRef).toBe(false);
      expect(providerRef.configSchema).toBeUndefined();
    }
  });

  it('loads provider extensions before the adapter contribution is processed', () => {
    expect(piSdkPackage.dependencies).toEqual(
      providerIds.map((definitionId) => dep(`provider-${definitionId}`, undefined, true)),
    );
  });

  it('keeps conformance helpers behind the test-only entrypoint', () => {
    expect('createTestConfig' in publicApi).toBe(false);
    expect(testApi.createTestConfig).toEqual(expect.any(Function));
  });
});

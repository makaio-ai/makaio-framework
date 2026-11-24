import { describe, expect, it } from 'vitest';
import { HostOnlyRightsError } from '@makaio/contracts/access';
import { createRefusingRightsCapability } from '@makaio/contracts/rights';

describe('the refusing rights capability', () => {
  it('rejects `resolve` with the typed refusal instead of throwing synchronously', async () => {
    const capability = createRefusingRightsCapability();

    // A synchronous call must not throw: only the returned promise rejects.
    const result = capability.resolve({} as never, { right: 'test.anything', context: {} });
    await expect(result).rejects.toBeInstanceOf(HostOnlyRightsError);
  });

  it('throws the typed refusal synchronously from every other member', () => {
    const capability = createRefusingRightsCapability();

    expect(() => capability.handlerContext({} as never)).toThrow(HostOnlyRightsError);
    expect(() => capability.sourceChanged('ext.anything.source')).toThrow(HostOnlyRightsError);
    expect(() => capability.declareRightsFromData([])).toThrow(HostOnlyRightsError);
    expect(() => capability.registerRightsSource({} as never)).toThrow(HostOnlyRightsError);
  });
});

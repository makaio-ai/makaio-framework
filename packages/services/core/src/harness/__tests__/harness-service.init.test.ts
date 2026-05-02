import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { HarnessService } from '../harness-service.js';

describe('HarnessService init failure lifecycle', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('rolls back failed init and allows retry attempts', async () => {
    const service = new HarnessService(MakaioBus);

    const firstError = await service.init().catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(Error);

    // Without rollback, the service would remain initialized and this call would no-op.
    const secondError = await service.init().catch((error: unknown) => error);
    expect(secondError).toBeInstanceOf(Error);

    service.destroy();
  });
});

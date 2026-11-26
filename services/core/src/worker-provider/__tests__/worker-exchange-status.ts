import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';

/** Private probe for the authenticated run's status in the test owner. */
export const exchangeStatus = createBusNamespace('exchangeStatus', {
  read: {
    request: z.strictObject({ jobRunId: z.string() }),
    response: z.strictObject({ expiresAt: z.string().optional() }),
  },
});

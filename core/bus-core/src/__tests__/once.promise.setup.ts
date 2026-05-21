import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';

// Register test namespaces for promise-based once tests
const { subjects: EventSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('oncePromise:events', {
    message: z.object({ content: z.string(), sessionId: z.string() }),
    status: z.object({ status: z.string() }),
    data: z.object({ value: z.number() }),
  }),
);

export const oncePromiseTestSetup = () => ({
  EventSubjects,
  beforeEach: () => {
    MakaioBus.__resetHandlers?.();
  },
});

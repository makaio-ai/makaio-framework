import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace, createMakaioContext } from '@makaio/core';
import { createTestCall } from '@makaio/test-utils';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { emitEvent } from '../tool-utils.js';

it('forwards the tool execution principal to the event handler', async () => {
  const bus = createBusInstance();
  const { subjects } = bus.registerNamespace(
    createBusNamespace('toolUtilsTest', { completed: z.object({ toolName: z.string() }) }),
  );
  const principal = { kind: 'makaio.extension', id: 'tool-requester' };
  const call = createTestCall({ principal });
  const observedPrincipals: (typeof call.principal)[] = [];

  bus.on(subjects.completed, (ctx) => {
    observedPrincipals.push(ctx.call.principal);
  });

  await emitEvent({ ...createMakaioContext(), bus, call }, subjects.completed, { toolName: 'example' });

  expect(observedPrincipals).toEqual([principal]);
});

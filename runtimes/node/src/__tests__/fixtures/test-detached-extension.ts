/**
 * Minimal detached extension fixture for integration testing.
 *
 * This script runs as a child process spawned by `StdioServerTransport`.
 * It:
 * 1. Registers lifecycle and test bus handlers before transport connect so
 *    subscriptions are advertised during the subscribe-sync handshake.
 * 2. Connects via `StdioClientTransport` (uses process.stdin / process.stdout).
 * 3. On receipt of `test.ping`, echoes it back on `test.pingEcho` with
 *    `echoed: true` merged into the payload.
 * 4. Exits cleanly when stdin closes (host disconnects).
 *
 * No framework services are initialised — this is a minimal bus peer fixture.
 */

import { createBusInstance } from '@makaio/bus-core';
import { StdioClientTransport } from '@makaio/bus-transport-stdio';
import { z } from 'zod';

const transport = new StdioClientTransport({ name: 'test-detached-child' });
const bus = createBusInstance({ transports: [transport] });

const { subjects: LifecycleSubjects } = bus.registerNamespace('extension.test-detached', {
  init: {
    request: z.object({
      config: z.unknown().optional(),
      context: z
        .object({
          dataDir: z.string().optional(),
          machineId: z.string().optional(),
          makaioHome: z.string().optional(),
          platform: z.string().optional(),
          username: z.string().optional(),
        })
        .optional(),
    }),
    response: z.object({ ready: z.boolean() }),
  },
  ready: z.object({
    ready: z.boolean(),
    config: z.unknown().optional(),
    context: z
      .object({
        dataDir: z.string().optional(),
        machineId: z.string().optional(),
        makaioHome: z.string().optional(),
        platform: z.string().optional(),
        username: z.string().optional(),
      })
      .optional(),
  }),
  destroy: {
    request: z.object({ reason: z.string().optional() }),
    response: z.object({ stopped: z.boolean() }),
  },
  stopped: z.object({ stopped: z.boolean() }),
});

const { subjects: TestSubjects } = bus.registerNamespace('test', {
  ping: z.object({ hello: z.string() }),
  pingEcho: z.object({ hello: z.string(), echoed: z.boolean() }),
});

bus.on(LifecycleSubjects.init, async (request) => {
  await bus.emit(LifecycleSubjects.ready, {
    ready: true,
    config: request.payload.config,
    context: request.payload.context,
  });
  request.setResult({ ready: true });
});

bus.on(LifecycleSubjects.destroy, async (request) => {
  await bus.emit(LifecycleSubjects.stopped, { stopped: true });
  request.setResult({ stopped: true });
});

bus.on(TestSubjects.ping, async (event) => {
  await bus.emit(TestSubjects.pingEcho, { ...event.payload, echoed: true });
});

await bus.connect();
await bus.ready;

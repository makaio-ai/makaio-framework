import { describe, expect, it } from 'vitest';
import { createBusInstance, NoHandlerError } from '@makaio/bus-core';
import { ExecutionAttemptNamespace, ExecutionAttemptSubjects } from '@makaio/contracts';
import { bootstrapWorkerRuntime, BootstrapStartRefusedError } from '../bootstrap-start-client.js';

describe('bootstrap start response parsing', () => {
  it.each([
    { status: 'unknown' },
    { status: 'permitted', credentials: 'must-not-be-accepted' },
    { status: 'refused' },
    { status: 'refused', reason: 'unknown' },
  ])('rejects malformed $status even when bus validation is disabled', async (response) => {
    const bus = createBusInstance();
    bus.registerNamespace({ ...ExecutionAttemptNamespace, options: { busValidationMode: 'skip' } });
    bus.on(ExecutionAttemptSubjects.bootstrap.awaitStart, (ctx) => ctx.setResult(response as never));
    let closed = 0;
    let connections = 0;
    await expect(
      bootstrapWorkerRuntime({
        executionAttemptId: 'attempt',
        runtimeIncarnationId: 'runtime',
        bootstrapDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
        signal: new AbortController().signal,
        createConnection: () => {
          connections += 1;
          return {
            bus,
            connect: async () => {},
            close: () => {
              closed += 1;
              bus.disconnect();
            },
          };
        },
      }),
    ).rejects.toThrow();
    expect(connections).toBe(1);
    expect(closed).toBe(1);
    expect(bus.getContext().requestHandlers.get('execution-attempt.operation.deliver') ?? []).toHaveLength(0);
  });

  it('preserves an explicit refusal without retrying or registering', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(ExecutionAttemptNamespace);
    bus.on(ExecutionAttemptSubjects.bootstrap.awaitStart, (ctx) =>
      ctx.setResult({ status: 'refused', reason: 'fenced' }),
    );
    let connections = 0;
    await expect(
      bootstrapWorkerRuntime({
        executionAttemptId: 'attempt',
        runtimeIncarnationId: 'runtime',
        bootstrapDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
        signal: new AbortController().signal,
        createConnection: () => {
          connections += 1;
          return { bus, connect: async () => {}, close: () => bus.disconnect() };
        },
      }),
    ).rejects.toEqual(new BootstrapStartRefusedError('fenced'));
    expect(connections).toBe(1);
  });

  it('does not fall back to registration when the start handler is absent', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(ExecutionAttemptNamespace);
    await expect(
      bootstrapWorkerRuntime({
        executionAttemptId: 'attempt',
        runtimeIncarnationId: 'runtime',
        bootstrapDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
        signal: new AbortController().signal,
        createConnection: () => ({ bus, connect: async () => {}, close: () => bus.disconnect() }),
      }),
    ).rejects.toBeInstanceOf(NoHandlerError);
  });
});

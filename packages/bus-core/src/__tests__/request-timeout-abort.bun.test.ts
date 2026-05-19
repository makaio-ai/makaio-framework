import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { MakaioBus, type BusMessage, type BusRequestMessage, type BusTransport } from '../index.js';

class PendingRequestTransport implements BusTransport {
  public readonly name = 'pending-request-transport';
  public lastTimeout: number | undefined;
  public cancelled: string[] = [];

  public send(message: BusRequestMessage, timeout?: number): Promise<unknown>;
  public send(message: BusMessage, timeout?: number): Promise<unknown | boolean>;
  public send(message: BusMessage, timeout?: number): Promise<unknown | boolean> {
    this.lastTimeout = timeout;
    if (message.type === 'request') {
      return new Promise(() => {});
    }
    return Promise.resolve(true);
  }

  public onReceive(handler: (message: BusMessage) => Promise<void>): () => void {
    void handler;
    return () => {
      // no-op
    };
  }

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async subscribe(): Promise<void> {}
  public async unsubscribe(): Promise<void> {}

  public cancelRequest(correlationId: string): void {
    this.cancelled.push(correlationId);
  }
}

const { subjects: RequestTimeoutSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('requestTimeoutAbort', {
    wait: {
      request: z.object({ value: z.string() }),
      response: z.object({ ok: z.boolean() }),
    },
  }),
);

declare module '../index.js' {
  interface BusTransportRegistry {
    pending: BusTransport;
  }

  interface BusSubjectsNamespace {
    requestTimeoutAbort: typeof RequestTimeoutSubjects;
  }
}

const { registerTransport } = MakaioBus.getContext().transportRegistry;

describe('request timeout=0 with AbortSignal', () => {
  let transport: PendingRequestTransport;
  let unregister: () => void;

  beforeEach(() => {
    transport = new PendingRequestTransport();
    unregister = registerTransport('pending', transport).unregister;
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    unregister();
    MakaioBus.__resetHandlers?.();
  });

  it('aborts local requests when timeout is 0', async () => {
    MakaioBus.on(RequestTimeoutSubjects.wait, async () => {
      await new Promise(() => {});
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('local-abort')), 10);

    await expect(
      MakaioBus.request(RequestTimeoutSubjects.wait, { value: 'x' }, { timeout: 0, signal: controller.signal }),
    ).rejects.toThrow('local-abort');
  });

  it('aborts transport requests when timeout is 0 and forwards timeout to transport', async () => {
    // Advertise the pending transport as the handler so dispatch routes to it.
    MakaioBus.getContext().remoteRequestHandlers.set('requestTimeoutAbort.wait', [
      { transport: 'pending', priority: 0 },
    ]);

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('transport-abort')), 10);

    await expect(
      MakaioBus.request(RequestTimeoutSubjects.wait, { value: 'x' }, { timeout: 0, signal: controller.signal }),
    ).rejects.toThrow('transport-abort');

    expect(transport.lastTimeout).toBe(0);
    expect(transport.cancelled).toHaveLength(1);
  });
});

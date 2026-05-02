import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '../index.js';
import type { BusEventMessage, BusMessage, BusRequestMessage, BusTransportRegistry, BusTransport } from '../index.js';

class RecordingTransport implements BusTransport {
  public readonly name = 'recording-transport';
  public readonly messages: BusMessage[] = [];
  private handler?: (message: BusMessage) => Promise<void>;

  public send(message: BusRequestMessage): Promise<unknown>;
  public send(message: BusEventMessage): Promise<boolean>;
  public send(message: BusMessage): Promise<unknown | boolean>;
  public send(message: BusMessage): Promise<unknown | boolean> {
    this.messages.push(message);
    return message.type === 'request' ? Promise.resolve({ ok: true }) : Promise.resolve(true);
  }

  public onReceive(handler: (message: BusMessage) => Promise<void>): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async subscribe(): Promise<void> {}
  public async unsubscribe(): Promise<void> {}

  public async simulateReceive(message: BusMessage): Promise<void> {
    await this.handler?.(message);
  }
}

class FailingTransport extends RecordingTransport {
  public send(message: BusRequestMessage): Promise<unknown>;
  public send(message: BusEventMessage): Promise<boolean>;
  public send(message: BusMessage): Promise<unknown | boolean>;
  public send(message: BusMessage): Promise<unknown | boolean> {
    this.messages.push(message);
    return Promise.reject(new Error('transport send failed'));
  }
}

const { subjects: RelayIsolationSubjects } = MakaioBus.registerNamespace('relayIsolation', {
  event: z.object({ value: z.string() }),
});

describe('Transport relay isolation', () => {
  let source: RecordingTransport;
  let relay: RecordingTransport;
  let failing: FailingTransport;
  let unregisterSource: () => void;
  let unregisterRelay: () => void;
  let unregisterFailing: () => void;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    source = new RecordingTransport();
    relay = new RecordingTransport();
    failing = new FailingTransport();
    const { registerTransport } = MakaioBus.getContext().transportRegistry;
    unregisterSource = registerTransport('source' as keyof BusTransportRegistry, source).unregister;
    unregisterRelay = registerTransport('relay' as keyof BusTransportRegistry, relay).unregister;
    unregisterFailing = registerTransport('failing' as keyof BusTransportRegistry, failing).unregister;
  });

  afterEach(() => {
    unregisterFailing();
    unregisterRelay();
    unregisterSource();
    MakaioBus.__resetHandlers?.();
  });

  it('keeps relaying and local processing when one relay transport throws', async () => {
    const received: Array<{ value: string }> = [];
    MakaioBus.on(RelayIsolationSubjects.event, ({ payload }) => {
      received.push(payload);
    });

    await expect(
      source.simulateReceive({
        type: 'event',
        namespace: 'relayIsolation',
        subject: 'event',
        payload: { value: 'ok' },
        messageId: 'relay-isolation-event',
      }),
    ).resolves.toBeUndefined();

    expect(relay.messages).toHaveLength(1);
    expect(relay.messages[0]).toMatchObject({
      type: 'event',
      namespace: 'relayIsolation',
      subject: 'event',
      payload: { value: 'ok' },
    });
    expect(received).toEqual([{ value: 'ok' }]);
  });
});

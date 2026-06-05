/**
 * Tests for the FileSystemService origin guard.
 *
 * Remote callers (origin.local === false) must supply a `machineId` in the
 * request payload unless they arrive through the host-owned SharedWorker bridge.
 * Without it the handler throws immediately. With a matching `machineId` the
 * request is executed normally. With a non-matching `machineId` the handler
 * returns without setting a result (declined, NoHandlerError).
 *
 * The tests use an isolated bus + StubTransport to drive the remote-origin
 * code paths without real WebSocket I/O.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  createBusContext,
  createBusInstance,
  type BusMessage,
  type BusReceiveHandler,
  type BusTransport,
} from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';
import { FsSubjects } from '../namespace.js';
import { FileSystemService } from '../filesystem-service.js';

// ---------------------------------------------------------------------------
// Minimal transport fixture (same pattern as subagent origin tests)
// ---------------------------------------------------------------------------

class StubTransport {
  public readonly name: string;
  public readonly messages: BusMessage[] = [];
  private handler?: BusReceiveHandler;

  public constructor(name: string) {
    this.name = name;
  }

  public send(message: BusMessage): Promise<boolean> {
    if (message.type !== 'subscribe-sync-complete') this.messages.push(message);
    return Promise.resolve(true);
  }

  public onReceive(handler: BusReceiveHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async subscribe(_subject: string): Promise<void> {}
  public async unsubscribe(_subject: string): Promise<void> {}

  /**
   * Simulate receiving a message from the remote side.
   * @param message - Message to inject
   * @param context - Optional trusted receive context
   */
  public async simulateReceive(message: BusMessage, context?: TransportReceiveContext): Promise<void> {
    if (this.handler) await this.handler(message, context);
  }
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const MACHINE_ID = 'test-node';
const OTHER_MACHINE_ID = 'other-node';
const CORR_ID = 'corr-fs-origin-1';
const MSG_ID = 'msg-fs-origin-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileSystemService — origin guard on readFile', () => {
  let tmpFile: string;
  const cleanupFns: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    tmpFile = path.join(os.tmpdir(), `fs-origin-test-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'hello origin guard');
  });

  afterEach(async () => {
    await fs.rm(tmpFile, { force: true });
    for (const fn of cleanupFns.splice(0)) await fn();
  });

  it('local readFile without machineId executes normally', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new FileSystemService(bus, MACHINE_ID);
    cleanupFns.push(() => service.destroy());
    await service.init();

    const result = await bus.request(FsSubjects.readFile, { path: tmpFile });

    expect(result.content).toBe('hello origin guard');
  });

  it('remote readFile without machineId throws', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new FileSystemService(bus, MACHINE_ID);
    cleanupFns.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('remote-fs');
    bus.registerTransport(transport as BusTransport);

    await transport.simulateReceive(
      {
        type: 'request',
        namespace: FsSubjects.readFile.$meta.namespace,
        subject: FsSubjects.readFile.subject as string,
        payload: { path: tmpFile },
        correlationId: CORR_ID,
        messageId: MSG_ID,
      },
      { transportName: 'remote-fs' },
    );

    const responses = transport.messages.filter((m) => m.type === 'response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      type: 'response',
      correlationId: CORR_ID,
      error: expect.objectContaining({
        message: expect.stringContaining('machineId is required for remote filesystem access'),
      }),
    });
  });

  it('host UI bridge readFile without machineId executes normally', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new FileSystemService(bus, MACHINE_ID);
    cleanupFns.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('worker');
    bus.registerTransport(transport as BusTransport);

    await transport.simulateReceive(
      {
        type: 'request',
        namespace: FsSubjects.readFile.$meta.namespace,
        subject: FsSubjects.readFile.subject as string,
        payload: { path: tmpFile },
        correlationId: CORR_ID,
        messageId: MSG_ID,
      },
      { transportName: 'worker' },
    );

    const responses = transport.messages.filter((m) => m.type === 'response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      type: 'response',
      correlationId: CORR_ID,
      result: { content: 'hello origin guard' },
    });
  });

  it('remote readFile with matching machineId executes normally', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new FileSystemService(bus, MACHINE_ID);
    cleanupFns.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('remote-fs-match');
    bus.registerTransport(transport as BusTransport);

    await transport.simulateReceive(
      {
        type: 'request',
        namespace: FsSubjects.readFile.$meta.namespace,
        subject: FsSubjects.readFile.subject as string,
        payload: { path: tmpFile, machineId: MACHINE_ID },
        correlationId: CORR_ID,
        messageId: MSG_ID,
      },
      { transportName: 'remote-fs-match' },
    );

    const responses = transport.messages.filter((m) => m.type === 'response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      type: 'response',
      correlationId: CORR_ID,
      result: { content: 'hello origin guard' },
    });
  });

  it('remote readFile with non-matching machineId is declined', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const service = new FileSystemService(bus, MACHINE_ID);
    cleanupFns.push(() => service.destroy());
    await service.init();

    const transport = new StubTransport('remote-fs-no-match');
    bus.registerTransport(transport as BusTransport);

    await transport.simulateReceive(
      {
        type: 'request',
        namespace: FsSubjects.readFile.$meta.namespace,
        subject: FsSubjects.readFile.subject as string,
        payload: { path: tmpFile, machineId: OTHER_MACHINE_ID },
        correlationId: CORR_ID,
        messageId: MSG_ID,
      },
      { transportName: 'remote-fs-no-match' },
    );

    // Handler returned without calling setResult → NoHandlerError response.
    const responses = transport.messages.filter((m) => m.type === 'response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      type: 'response',
      correlationId: CORR_ID,
      error: expect.objectContaining({ message: expect.any(String) }),
    });
    // The response must not have a result field (error, not success).
    expect(responses[0]).not.toHaveProperty('result');
  });
});

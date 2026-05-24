/**
 * Tests for the `@makaio/inbound-hooks` package.
 *
 * All tests exercise real implementations: the bus instance is a real
 * `createBusInstance()` with no stubs, and handlers verify the full emit
 * path end-to-end within the process.
 */

import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  RawInboundHookPayloadSchema,
  createInboundHookNamespace,
  createInboundHookReceivedSubject,
  emitInboundHookReceived,
  parseJsonMetadata,
  parseJsonPayload,
  readProcessStdinText,
  safeReadStdinText,
} from '../index.js';

describe('inbound hooks', () => {
  it('creates a source-scoped hook namespace', () => {
    const namespace = createInboundHookNamespace('git');

    expect(namespace.name).toBe('hook:git');
    expect(namespace.subjects.received.subject).toBe('received');
    expect(namespace.subjects.received.$meta.namespace).toBe('hook:git');
  });

  it('creates a non-owning source-scoped received subject', () => {
    const subject = createInboundHookReceivedSubject('git');

    expect(subject.subject).toBe('received');
    expect(subject.$meta.namespace).toBe('hook:git');
  });

  it('rejects invalid source identifiers', () => {
    expect(() => createInboundHookReceivedSubject('git/status')).toThrow(/source/);
  });

  it('parses invalid payload JSON as an empty object', () => {
    expect(parseJsonPayload('{')).toEqual({});
  });

  it('omits invalid metadata JSON', () => {
    expect(parseJsonMetadata('{')).toBeUndefined();
  });

  it('emits a raw inbound hook payload to the source namespace', async () => {
    const bus = createBusInstance();
    const namespace = bus.registerNamespace(createInboundHookNamespace('git'));
    const seen: unknown[] = [];
    const cleanup = bus.on(namespace.subjects.received, ({ payload }) => {
      seen.push(payload);
    });

    await emitInboundHookReceived(bus, 'git', {
      eventName: 'post-commit',
      receivedAt: 1,
      argv: [],
      stdinText: '',
      payload: { repoPath: '/repo' },
    });

    cleanup();
    expect(seen).toHaveLength(1);
    expect(RawInboundHookPayloadSchema.parse(seen[0])).toMatchObject({
      eventName: 'post-commit',
      payload: { repoPath: '/repo' },
    });
  });

  it('swallows emit failures when failOpen is true', async () => {
    const bus = createBusInstance();
    const namespace = bus.registerNamespace(createInboundHookNamespace('git'));
    const cleanup = bus.on(namespace.subjects.received, () => {
      throw new Error('offline');
    });

    try {
      await expect(
        emitInboundHookReceived(bus, 'git', {
          eventName: 'post-commit',
          receivedAt: 1,
          argv: [],
          stdinText: '',
          payload: {},
        }),
      ).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('rethrows emit failures when failOpen is false', async () => {
    const bus = createBusInstance();
    const namespace = bus.registerNamespace(createInboundHookNamespace('git'));
    const cleanup = bus.on(namespace.subjects.received, () => {
      throw new Error('offline');
    });

    try {
      await expect(
        emitInboundHookReceived(
          bus,
          'git',
          {
            eventName: 'post-commit',
            receivedAt: 1,
            argv: [],
            stdinText: '',
            payload: {},
          },
          { failOpen: false },
        ),
      ).rejects.toThrow('offline');
    } finally {
      cleanup();
    }
  });

  it('returns empty string when stdin is a TTY', async () => {
    const ttyStream = { isTTY: true } as NodeJS.ReadStream;
    expect(await readProcessStdinText(ttyStream)).toBe('');
  });

  it('returns empty string when the read function throws', async () => {
    expect(
      await safeReadStdinText(async () => {
        throw new Error('fail');
      }),
    ).toBe('');
  });
});

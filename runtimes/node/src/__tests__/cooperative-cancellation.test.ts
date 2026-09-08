import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { BusAbortError } from '@makaio/bus-core';
import { isCooperativeCancellation } from '../cooperative-cancellation.js';

describe('cooperative local cancellation', () => {
  it.each(['filesystem', 'timer'] as const)('recognizes a real Node %s abort by its exact cause', async (operation) => {
    const controller = new AbortController();
    const reason = new Error('requested stop');
    controller.abort(reason);
    const result =
      operation === 'filesystem'
        ? readFile(import.meta.filename, { signal: controller.signal })
        : delay(1, undefined, { signal: controller.signal });
    const error: unknown = await result.catch((error: unknown) => error);
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause: reason });
    expect(isCooperativeCancellation(error, controller.signal)).toBe(true);
    const foreign = AbortSignal.abort(new Error('different stop'));
    expect(isCooperativeCancellation(error, foreign)).toBe(false);
    expect(isCooperativeCancellation(error, new AbortController().signal)).toBe(false);
  });

  it('does not accept a matching-looking Node error without all provenance fields', () => {
    const reason = new Error('requested stop');
    const signal = AbortSignal.abort(reason);
    const errors = [
      Object.assign(new Error('not an abort', { cause: reason }), { code: 'ABORT_ERR' }),
      Object.assign(new Error('wrong code', { cause: reason }), { name: 'AbortError', code: 'OTHER' }),
      Object.assign(new Error('missing cause'), { name: 'AbortError', code: 'ABORT_ERR' }),
    ];
    for (const error of errors) expect(isCooperativeCancellation(error, signal)).toBe(false);
  });

  it('preserves direct reasons and DOM convention while keeping Bus provenance authoritative', () => {
    const reason = new Error('requested stop');
    const signal = AbortSignal.abort(reason);
    expect(isCooperativeCancellation(reason, signal)).toBe(true);
    expect(isCooperativeCancellation(new DOMException('stopped', 'AbortError'), signal)).toBe(true);
    expect(isCooperativeCancellation(new BusAbortError(reason), signal)).toBe(true);
    expect(isCooperativeCancellation(new BusAbortError(new Error('foreign stop')), signal)).toBe(false);
  });
});

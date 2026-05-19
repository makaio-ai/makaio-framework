/// <reference types="bun-types" />
/**
 * Tests for {@link requestKernelRestart}.
 *
 * Uses a mock bus to verify that the wrapper correctly delegates to the
 * kernel restart subject, passes the reason field, and throws when the
 * host declines.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createMockBus, createTestBusInstance, type MockBusResult } from '@makaio/test-utils';
import { KernelSubjects } from '@makaio/kernel';
import { requestKernelRestart } from '../bus/kernel-ops.js';

describe('requestKernelRestart', () => {
  let mockBus: MockBusResult;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('calls bus.request with KernelSubjects.restart and the provided reason', async () => {
    mockBus.request.mockResolvedValue({ accepted: true });

    await requestKernelRestart(mockBus.bus, 'extension installed');

    expect(mockBus.request).toHaveBeenCalledTimes(1);
    expect(mockBus.request).toHaveBeenCalledWith(KernelSubjects.restart, {
      reason: 'extension installed',
    });
  });

  it('calls bus.request with an undefined reason when none is provided', async () => {
    mockBus.request.mockResolvedValue({ accepted: true });

    await requestKernelRestart(mockBus.bus);

    expect(mockBus.request).toHaveBeenCalledWith(KernelSubjects.restart, {
      reason: undefined,
    });
  });

  it('resolves without a value when the restart is accepted', async () => {
    mockBus.request.mockResolvedValue({ accepted: true });

    await expect(requestKernelRestart(mockBus.bus)).resolves.toBeUndefined();
  });

  it('throws when the host does not accept the restart request', async () => {
    mockBus.request.mockResolvedValue({ accepted: false });

    await expect(requestKernelRestart(mockBus.bus)).rejects.toThrow('Kernel restart was not accepted by the host');
  });

  it('exercises the restart subject through a real bus handler', async () => {
    const bus = createTestBusInstance();
    const unsubscribe = bus.on(KernelSubjects.restart, (ctx) => {
      expect(ctx.payload.reason).toBe('integration-test');
      ctx.setResult({ accepted: true });
    });

    await requestKernelRestart(bus, 'integration-test');

    unsubscribe();
  });
});

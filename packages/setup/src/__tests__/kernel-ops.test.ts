/**
 * Tests for {@link requestKernelRestart}.
 *
 * Uses a mock bus to verify that the wrapper correctly delegates to the
 * kernel restart subject, forwards the call and reason, and throws when the
 * host declines.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createMockBus, createTestBusInstance, createTestCall, type MockBusResult } from '@makaio/test-utils';
import { KernelSubjects } from '@makaio/kernel';
import { requestKernelRestart } from '../bus/kernel-ops.js';

describe('requestKernelRestart', () => {
  let mockBus: MockBusResult;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('calls bus.request with the call, KernelSubjects.restart, and the provided reason', async () => {
    const call = createTestCall();
    mockBus.request.mockResolvedValue({ accepted: true });

    await requestKernelRestart(call, mockBus.bus, 'extension installed');

    expect(mockBus.request).toHaveBeenCalledOnce();
    expect(mockBus.request).toHaveBeenCalledWith(call, KernelSubjects.restart, {
      reason: 'extension installed',
    });
  });

  it('calls bus.request with an undefined reason when none is provided', async () => {
    const call = createTestCall();
    mockBus.request.mockResolvedValue({ accepted: true });

    await requestKernelRestart(call, mockBus.bus);

    expect(mockBus.request).toHaveBeenCalledWith(call, KernelSubjects.restart, {
      reason: undefined,
    });
  });

  it('resolves without a value when the restart is accepted', async () => {
    mockBus.request.mockResolvedValue({ accepted: true });

    await expect(requestKernelRestart(createTestCall(), mockBus.bus)).resolves.toBeUndefined();
  });

  it('throws when the host does not accept the restart request', async () => {
    mockBus.request.mockResolvedValue({ accepted: false });

    await expect(requestKernelRestart(createTestCall(), mockBus.bus)).rejects.toThrow(
      'Kernel restart was not accepted by the host',
    );
  });

  it('exercises the restart subject through a real bus handler', async () => {
    const bus = createTestBusInstance();
    const unsubscribe = bus.on(KernelSubjects.restart, (ctx) => {
      expect(ctx.payload.reason).toBe('integration-test');
      ctx.setResult({ accepted: true });
    });

    await requestKernelRestart(bus.own('root'), bus, 'integration-test');

    unsubscribe();
  });
});

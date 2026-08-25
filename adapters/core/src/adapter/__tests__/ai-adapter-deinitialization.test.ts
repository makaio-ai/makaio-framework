import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { countSubjectHandlers } from '@makaio/test-utils';
import { createTestAdapter, registerAgentRowStorage, registerStartReservationAuthority } from './shared.js';

describe('AIAdapter deinitialization', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('publishes one withdrawal for repeated direct closes', async () => {
    const { adapter } = createTestAdapter('direct-close');
    const withdrawn = vi.fn();
    const onClose = vi.fn(async () => undefined);
    Object.defineProperty(adapter, 'onClose', { value: onClose });
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    await adapter.init();
    const firstClose = adapter.closeAsync();
    await firstClose;
    const secondClose = adapter.closeAsync();
    await secondClose;

    expect(secondClose).toBe(firstClose);
    expect(onClose).toHaveBeenCalledOnce();
    expect(withdrawn).toHaveBeenCalledOnce();
  });

  it('retries a rejected close instead of memoizing failed teardown', async () => {
    const { adapter } = createTestAdapter('retry-rejected-close');
    const withdrawn = vi.fn();
    const onClose = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient close failure'))
      .mockResolvedValueOnce({ evidence: 'released' as const });
    Object.defineProperty(adapter, 'onClose', { value: onClose });
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    await adapter.init();
    await expect(adapter.closeAsync()).rejects.toThrow('transient close failure');
    await expect(adapter.closeAsync()).resolves.toEqual({ evidence: 'released' });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(withdrawn).toHaveBeenCalledOnce();
  });

  it('retries teardown after initialization rollback rejects', async () => {
    const { adapter } = createTestAdapter('retry-rejected-initialization-rollback');
    const onClose = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient rollback failure'))
      .mockResolvedValueOnce({ evidence: 'released' as const });
    Object.defineProperty(adapter, 'onInit', { value: async () => Promise.reject(new Error('initialization failed')) });
    Object.defineProperty(adapter, 'onClose', { value: onClose });

    await expect(adapter.init()).rejects.toThrow('Adapter initialization and rollback failed');
    await expect(adapter.closeAsync()).resolves.toEqual({ evidence: 'released' });

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('completes rejected teardown before reinitializing', async () => {
    const { adapter } = createTestAdapter('close-before-reinitialize');
    const onInit = vi.fn(async () => undefined);
    const onClose = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient close failure'))
      .mockResolvedValueOnce({ evidence: 'released' as const });
    Object.defineProperty(adapter, 'onInit', { value: onInit });
    Object.defineProperty(adapter, 'onClose', { value: onClose });

    await adapter.init();
    await expect(adapter.closeAsync()).rejects.toThrow('transient close failure');
    await expect(adapter.init()).resolves.toBeUndefined();

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onInit).toHaveBeenCalledTimes(2);
    expect(adapter.isInitialized()).toBe(true);
    await adapter.closeAsync();
  });

  it('completes rejected teardown before an already queued initialization', async () => {
    const { adapter } = createTestAdapter('queued-init-after-rejected-close');
    const closeEntered = Promise.withResolvers<void>();
    const closeGate = Promise.withResolvers<void>();
    const onInit = vi.fn(async () => undefined);
    const onClose = vi.fn(async () => {
      if (onClose.mock.calls.length !== 1) return { evidence: 'released' as const };
      closeEntered.resolve();
      await closeGate.promise;
      return { evidence: 'released' as const };
    });
    Object.defineProperty(adapter, 'onInit', { value: onInit });
    Object.defineProperty(adapter, 'onClose', { value: onClose });

    await adapter.init();
    const close = adapter.closeAsync();
    await closeEntered.promise;
    const reinitialize = adapter.init();
    const rejectedClose = expect(close).rejects.toThrow('transient close failure');
    closeGate.reject(new Error('transient close failure'));

    await rejectedClose;
    await expect(reinitialize).resolves.toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onInit).toHaveBeenCalledTimes(2);
    expect(adapter.isInitialized()).toBe(true);
    await adapter.closeAsync();
  });

  it('publishes exact initialized and withdrawn identity payloads', async () => {
    const { adapter } = createTestAdapter('exact-lifecycle-payload', {
      adapterId: 'exact-adapter-id',
      machineId: 'exact-machine-id',
      ownerInstanceId: 'exact-owner-instance-id',
    });
    const initializedPayloads: unknown[] = [];
    const withdrawnPayloads: unknown[] = [];
    MakaioBus.on(AdapterSubjects.initialized, (ctx) => {
      initializedPayloads.push(ctx.payload);
    });
    MakaioBus.on(AdapterSubjects.deinitialized, (ctx) => {
      withdrawnPayloads.push(ctx.payload);
    });

    await adapter.init();
    await adapter.closeAsync();

    expect(initializedPayloads).toEqual([
      {
        adapterId: 'exact-adapter-id',
        adapterName: 'exact-lifecycle-payload',
        machineId: 'exact-machine-id',
        ownerInstanceId: 'exact-owner-instance-id',
        capabilities: [],
        nativeTools: [],
      },
    ]);
    expect(withdrawnPayloads).toEqual([
      {
        adapterId: 'exact-adapter-id',
        adapterName: 'exact-lifecycle-payload',
        machineId: 'exact-machine-id',
        ownerInstanceId: 'exact-owner-instance-id',
      },
    ]);
  });

  it('single-flights concurrent initialization', async () => {
    const { adapter } = createTestAdapter('concurrent-init');
    const initialized = vi.fn();
    const initGate = Promise.withResolvers<void>();
    const onInit = vi.fn(async () => initGate.promise);
    Object.defineProperty(adapter, 'onInit', { value: onInit });
    MakaioBus.on(AdapterSubjects.initialized, initialized);

    const initA = adapter.init();
    const initB = adapter.init();
    await new Promise((resolve) => setImmediate(resolve));
    initGate.resolve();
    await Promise.all([initA, initB]);

    expect(initB).toBe(initA);
    expect(onInit).toHaveBeenCalledOnce();
    expect(initialized).toHaveBeenCalledOnce();
    await adapter.closeAsync();
  });

  it('serializes close behind initialization', async () => {
    const { adapter } = createTestAdapter('close-during-init');
    const initialized = vi.fn();
    const withdrawn = vi.fn();
    const initGate = Promise.withResolvers<void>();
    const onClose = vi.fn(async () => undefined);
    Object.defineProperty(adapter, 'onInit', { value: async () => initGate.promise });
    Object.defineProperty(adapter, 'onClose', { value: onClose });
    MakaioBus.on(AdapterSubjects.initialized, initialized);
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    const init = adapter.init();
    await new Promise((resolve) => setImmediate(resolve));
    const close = adapter.closeAsync();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onClose).not.toHaveBeenCalled();

    initGate.resolve();
    await Promise.all([init, close]);

    expect(adapter.isInitialized()).toBe(false);
    expect(initialized).toHaveBeenCalledOnce();
    expect(withdrawn).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('orders a close behind an initialization queued during the prior close', async () => {
    const { adapter } = createTestAdapter('close-after-queued-reinit');
    const initialized = vi.fn();
    const withdrawn = vi.fn();
    const onClose = vi.fn(async () => undefined);
    const withdrawalEntered = Promise.withResolvers<void>();
    const releaseFirstWithdrawal = Promise.withResolvers<void>();
    Object.defineProperty(adapter, 'onClose', { value: onClose });
    MakaioBus.on(AdapterSubjects.initialized, initialized);
    MakaioBus.on(AdapterSubjects.deinitialized, async () => {
      withdrawn();
      if (withdrawn.mock.calls.length !== 1) return;
      withdrawalEntered.resolve();
      await releaseFirstWithdrawal.promise;
    });

    await adapter.init();
    const closeFirstGeneration = adapter.closeAsync();
    await withdrawalEntered.promise;
    const initializeSecondGeneration = adapter.init();
    const closeSecondGeneration = adapter.closeAsync();
    releaseFirstWithdrawal.resolve();
    await Promise.all([closeFirstGeneration, initializeSecondGeneration, closeSecondGeneration]);

    expect(adapter.isInitialized()).toBe(false);
    expect(initialized).toHaveBeenCalledTimes(2);
    expect(withdrawn).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('orders reinitialization behind a close queued during initialization', async () => {
    const { adapter } = createTestAdapter('reinit-after-queued-close');
    const initialized = vi.fn();
    const withdrawn = vi.fn();
    const firstInitializationEntered = Promise.withResolvers<void>();
    const releaseFirstInitialization = Promise.withResolvers<void>();
    const onInit = vi.fn(async () => {
      if (onInit.mock.calls.length !== 1) return;
      firstInitializationEntered.resolve();
      await releaseFirstInitialization.promise;
    });
    Object.defineProperty(adapter, 'onInit', { value: onInit });
    MakaioBus.on(AdapterSubjects.initialized, initialized);
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    const initializeFirstGeneration = adapter.init();
    await firstInitializationEntered.promise;
    const closeFirstGeneration = adapter.closeAsync();
    const initializeSecondGeneration = adapter.init();
    releaseFirstInitialization.resolve();
    await Promise.all([initializeFirstGeneration, closeFirstGeneration, initializeSecondGeneration]);

    expect(adapter.isInitialized()).toBe(true);
    expect(onInit).toHaveBeenCalledTimes(2);
    expect(initialized).toHaveBeenCalledTimes(2);
    expect(withdrawn).toHaveBeenCalledOnce();
    await adapter.closeAsync();
  });

  it('publishes one withdrawal for concurrent direct closes', async () => {
    const { adapter } = createTestAdapter('concurrent-close');
    const withdrawn = vi.fn();
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    await adapter.init();
    await Promise.all([adapter.closeAsync(), adapter.closeAsync()]);

    expect(withdrawn).toHaveBeenCalledOnce();
  });

  it('does not let a joined close finalize a reinitialized adapter generation', async () => {
    const { adapter } = createTestAdapter('reinit-after-first-close');
    const initialized = vi.fn();
    const withdrawn = vi.fn();
    const firstCloseGate = Promise.withResolvers<void>();
    const secondCloseGate = Promise.withResolvers<void>();
    // Separate gates reproduce the broken implementation's staggered A/B work;
    // a correct implementation never enters the second hook because B joins A.
    const onClose = vi.fn(async () => {
      const gate = onClose.mock.calls.length === 1 ? firstCloseGate : secondCloseGate;
      await gate.promise;
    });
    Object.defineProperty(adapter, 'onClose', { value: onClose });
    MakaioBus.on(AdapterSubjects.initialized, initialized);
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    try {
      await adapter.init();
      const closeA = adapter.closeAsync();
      await new Promise((resolve) => setImmediate(resolve));
      const closeB = adapter.closeAsync();
      await new Promise((resolve) => setImmediate(resolve));

      firstCloseGate.resolve();
      await closeA;
      await adapter.init();
      secondCloseGate.resolve();
      await closeB;

      expect(closeB).toBe(closeA);
      expect(onClose).toHaveBeenCalledOnce();
      expect(adapter.isInitialized()).toBe(true);
      expect(initialized).toHaveBeenCalledTimes(2);
      expect(withdrawn).toHaveBeenCalledOnce();
      await expect(
        MakaioBus.request(AdapterSubjects.getCapabilities, { adapterId: adapter.adapterId }),
      ).resolves.toEqual({ capabilities: [], nativeTools: [] });
    } finally {
      firstCloseGate.resolve();
      secondCloseGate.resolve();
      await adapter.closeAsync();
    }
  });

  it('serializes reinitialization behind a pending close publication', async () => {
    const { adapter } = createTestAdapter('reinit-during-withdrawal');
    const initialized = vi.fn();
    const withdrawn = vi.fn();
    const withdrawalEntered = Promise.withResolvers<void>();
    const releaseWithdrawal = Promise.withResolvers<void>();
    MakaioBus.on(AdapterSubjects.initialized, initialized);
    MakaioBus.on(AdapterSubjects.deinitialized, async () => {
      withdrawn();
      withdrawalEntered.resolve();
      await releaseWithdrawal.promise;
    });

    await adapter.init();
    const close = adapter.closeAsync();
    await withdrawalEntered.promise;
    const reinitialize = adapter.init();
    await new Promise((resolve) => setImmediate(resolve));

    expect(initialized).toHaveBeenCalledOnce();
    releaseWithdrawal.resolve();
    await close;
    await reinitialize;

    expect(adapter.isInitialized()).toBe(true);
    expect(initialized).toHaveBeenCalledTimes(2);
    await adapter.closeAsync();
    expect(withdrawn).toHaveBeenCalledTimes(2);
  });

  it('reopens real start admission after close and reinitialization', async () => {
    const { adapter } = createTestAdapter('reinit-start-admission');
    const cleanups = [registerStartReservationAuthority(), registerAgentRowStorage()];

    try {
      await adapter.init();
      await adapter.closeAsync();
      await adapter.init();

      const started = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead',
      });
      expect(started.success).toBe(true);
    } finally {
      await adapter.closeAsync();
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('rolls back failed onInit handlers and permits a clean retry', async () => {
    const { adapter } = createTestAdapter('retry-on-init-failure');
    const initializationError = new Error('onInit failed');
    const initialized = vi.fn();
    const onInit = vi.fn().mockRejectedValueOnce(initializationError).mockResolvedValue(undefined);
    Object.defineProperty(adapter, 'onInit', { value: onInit });
    MakaioBus.on(AdapterSubjects.initialized, initialized);

    await expect(adapter.init()).rejects.toBe(initializationError);
    expect(adapter.isInitialized()).toBe(false);
    expect(countSubjectHandlers(MakaioBus, AdapterSubjects.getCapabilities)).toBe(0);

    await adapter.init();
    expect(adapter.isInitialized()).toBe(true);
    expect(onInit).toHaveBeenCalledTimes(2);
    expect(initialized).toHaveBeenCalledOnce();
    expect(countSubjectHandlers(MakaioBus, AdapterSubjects.getCapabilities)).toBe(1);
    await adapter.closeAsync();
  });

  it('compensates a failed initialized publication and permits a clean retry', async () => {
    const { adapter } = createTestAdapter('retry-publication-failure');
    const initialized = vi.fn();
    const withdrawn = vi.fn();
    let rejectPublication = true;
    MakaioBus.on(AdapterSubjects.initialized, () => {
      initialized();
      if (rejectPublication) {
        rejectPublication = false;
        throw new Error('initialized observer failed');
      }
    });
    MakaioBus.on(AdapterSubjects.deinitialized, withdrawn);

    await expect(adapter.init()).rejects.toThrow('initialized observer failed');
    expect(adapter.isInitialized()).toBe(false);
    expect(withdrawn).toHaveBeenCalledOnce();
    expect(countSubjectHandlers(MakaioBus, AdapterSubjects.getCapabilities)).toBe(0);

    await adapter.init();
    expect(adapter.isInitialized()).toBe(true);
    expect(initialized).toHaveBeenCalledTimes(2);
    expect(countSubjectHandlers(MakaioBus, AdapterSubjects.getCapabilities)).toBe(1);
    await adapter.closeAsync();
  });

  it('rejects a blank machine identity', () => {
    expect(() => createTestAdapter('blank-machine', { machineId: '   ' })).toThrow(
      'requires a machine identity before announcing initialization',
    );
  });

  it('leaves the adapter closed and reinitializable when a withdrawal subscriber rejects', async () => {
    const { adapter } = createTestAdapter('rejecting-withdrawal');
    const initialized = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    MakaioBus.on(AdapterSubjects.initialized, initialized);
    const removeRejectingSubscriber = MakaioBus.on(AdapterSubjects.deinitialized, () => {
      throw new Error('observer failed');
    });

    try {
      await adapter.init();
      await expect(adapter.closeAsync()).resolves.toMatchObject({ evidence: 'released' });
      await adapter.init();

      expect(initialized).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to publish deinitialization'),
        expect.any(Error),
      );
    } finally {
      removeRejectingSubscriber();
      warn.mockRestore();
      await adapter.closeAsync();
    }
  });
});

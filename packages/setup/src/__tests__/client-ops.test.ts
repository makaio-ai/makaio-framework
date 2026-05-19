/**
 * Tests for {@link loadClientInventory} and {@link activateManagedPins}.
 *
 * Uses a mock bus to verify that the wrappers correctly delegate to the
 * client scan, list, setActive, and update bus subjects, and that
 * activateManagedPins handles all three code paths (already-active, installed
 * pin, and install-required pin).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockBus, createTestBusInstance, type MockBusResult } from '@makaio/test-utils';
import { ClientSubjects } from '@makaio/contracts/client';
import { loadClientInventory, activateManagedPins, type ClientInventoryResult } from '../bus/client-ops.js';
import type { SetupClientBinaryInventory } from '../types.js';

// ---------------------------------------------------------------------------
// loadClientInventory
// ---------------------------------------------------------------------------

describe('loadClientInventory', () => {
  let mockBus: MockBusResult;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('issues scan and list requests in parallel', async () => {
    mockBus.request.mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({ clients: [] });

    await loadClientInventory(mockBus.bus, []);

    expect(mockBus.request).toHaveBeenCalledTimes(2);
    expect(mockBus.request).toHaveBeenCalledWith(ClientSubjects.scan, {
      targets: [],
    });
    expect(mockBus.request).toHaveBeenCalledWith(ClientSubjects.list, {});
  });

  it('forwards targets to the scan request', async () => {
    mockBus.request
      .mockResolvedValue({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ clients: [] });

    await loadClientInventory(mockBus.bus, [
      { clientId: 'claude-code', binaryName: 'claude' },
      { clientId: 'codex', binaryName: 'codex' },
    ]);

    expect(mockBus.request).toHaveBeenCalledWith(ClientSubjects.scan, {
      targets: [
        { clientId: 'claude-code', binaryName: 'claude' },
        { clientId: 'codex', binaryName: 'codex' },
      ],
    });
  });

  it('maps scan results to globalResults with version or null', async () => {
    mockBus.request
      .mockResolvedValueOnce({
        results: [
          { clientId: 'claude-code', found: true, version: '1.2.3' },
          { clientId: 'codex', found: false },
        ],
      })
      .mockResolvedValueOnce({ clients: [] });

    const result: ClientInventoryResult = await loadClientInventory(mockBus.bus, []);

    expect(result.globalResults.get('claude-code')).toBe('1.2.3');
    expect(result.globalResults.get('codex')).toBeNull();
  });

  it('maps list response to managedClients keyed by clientId', async () => {
    mockBus.request.mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({
      clients: [
        {
          clientId: 'claude-code',
          installedVersions: [{ version: '1.0.0', installPath: '/path', installedAt: 0, isActive: true }],
          activeVersion: '1.0.0',
          pinnedVersion: '1.0.0',
          updateAvailable: false,
        },
      ],
    });

    const result = await loadClientInventory(mockBus.bus, []);

    const entry = result.managedClients.get('claude-code');
    expect(entry).toBeDefined();
    expect(entry?.clientId).toBe('claude-code');
    expect(entry?.installedVersions).toEqual(['1.0.0']);
    expect(entry?.activeVersion).toBe('1.0.0');
    expect(entry?.pinnedVersion).toBe('1.0.0');
  });

  it('returns empty maps when both responses are empty', async () => {
    mockBus.request.mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({ clients: [] });

    const result = await loadClientInventory(mockBus.bus, []);

    expect(result.globalResults.size).toBe(0);
    expect(result.managedClients.size).toBe(0);
  });

  it('loads inventory through real bus handlers', async () => {
    const bus = createTestBusInstance();
    const cleanupScan = bus.on(ClientSubjects.scan, (ctx) => {
      expect(ctx.payload.targets).toEqual([{ clientId: 'claude-code', binaryName: 'claude' }]);
      ctx.setResult({ results: [{ clientId: 'claude-code', found: true, version: '1.2.3' }] });
    });
    const cleanupList = bus.on(ClientSubjects.list, (ctx) => {
      ctx.setResult({
        clients: [
          {
            clientId: 'claude-code',
            installedVersions: [{ version: '1.2.3', installPath: '/bin/claude', installedAt: 1, isActive: true }],
            activeVersion: '1.2.3',
            pinnedVersion: '1.2.3',
            updateAvailable: false,
          },
        ],
      });
    });

    const result = await loadClientInventory(bus, [{ clientId: 'claude-code', binaryName: 'claude' }]);

    expect(result.globalResults.get('claude-code')).toBe('1.2.3');
    expect(result.managedClients.get('claude-code')).toEqual({
      clientId: 'claude-code',
      installedVersions: ['1.2.3'],
      activeVersion: '1.2.3',
      pinnedVersion: '1.2.3',
    });
    cleanupScan();
    cleanupList();
  });
});

// ---------------------------------------------------------------------------
// activateManagedPins
// ---------------------------------------------------------------------------

describe('activateManagedPins', () => {
  let mockBus: MockBusResult;

  /**
   * Builds a minimal SetupClientBinaryInventory for test setup.
   * @param overrides - Fields to override.
   * @returns A complete SetupClientBinaryInventory.
   */
  function makeInventory(overrides: Partial<SetupClientBinaryInventory>): SetupClientBinaryInventory {
    return {
      clientId: 'test-client',
      installedVersions: [],
      activeVersion: null,
      pinnedVersion: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('is a no-op when the map is empty', async () => {
    await activateManagedPins(mockBus.bus, new Map());

    expect(mockBus.request).not.toHaveBeenCalled();
    expect(mockBus.on).not.toHaveBeenCalled();
  });

  it('skips clients with null pinnedVersion', async () => {
    const clients = new Map([['no-pin', makeInventory({ pinnedVersion: null })]]);

    await activateManagedPins(mockBus.bus, clients);

    expect(mockBus.request).not.toHaveBeenCalled();
  });

  it('skips clients where activeVersion already equals pinnedVersion', async () => {
    const clients = new Map([['up-to-date', makeInventory({ activeVersion: '1.0.0', pinnedVersion: '1.0.0' })]]);

    await activateManagedPins(mockBus.bus, clients);

    expect(mockBus.request).not.toHaveBeenCalled();
  });

  it('calls setActive when the pin is installed but not the active version', async () => {
    mockBus.request.mockResolvedValue({
      clientId: 'test-client',
      activeVersion: '1.1.0',
    });

    const clients = new Map([
      [
        'test-client',
        makeInventory({
          clientId: 'test-client',
          installedVersions: ['1.0.0', '1.1.0'],
          activeVersion: '1.0.0',
          pinnedVersion: '1.1.0',
        }),
      ],
    ]);

    await activateManagedPins(mockBus.bus, clients);

    expect(mockBus.request).toHaveBeenCalledOnce();
    expect(mockBus.request).toHaveBeenCalledWith(ClientSubjects.setActive, {
      clientId: 'test-client',
      version: '1.1.0',
    });
  });

  it('activates an installed pin through a real bus handler', async () => {
    const bus = createTestBusInstance();
    const cleanup = bus.on(ClientSubjects.setActive, (ctx) => {
      expect(ctx.payload).toEqual({ clientId: 'test-client', version: '1.1.0' });
      ctx.setResult({ clientId: 'test-client', activeVersion: '1.1.0' });
    });
    const clients = new Map([
      [
        'test-client',
        makeInventory({
          clientId: 'test-client',
          installedVersions: ['1.1.0'],
          activeVersion: null,
          pinnedVersion: '1.1.0',
        }),
      ],
    ]);

    await activateManagedPins(bus, clients);

    cleanup();
  });

  it('does not subscribe to installJob.completed when using setActive path', async () => {
    mockBus.request.mockResolvedValue({
      clientId: 'test-client',
      activeVersion: '1.1.0',
    });

    const clients = new Map([
      [
        'test-client',
        makeInventory({
          clientId: 'test-client',
          installedVersions: ['1.1.0'],
          activeVersion: null,
          pinnedVersion: '1.1.0',
        }),
      ],
    ]);

    await activateManagedPins(mockBus.bus, clients);

    expect(mockBus.on).not.toHaveBeenCalled();
  });

  it('calls update and waits for installJob.completed when pin is not installed', async () => {
    const jobId = 'job-abc';
    mockBus.request.mockResolvedValue({ jobId, resolvedVersion: '2.0.0' });

    // Simulate installJob.completed firing for the matching job
    mockBus.on.mockImplementation((_subject, handler) => {
      // Fire the handler asynchronously so the Promise resolves
      void Promise.resolve().then(() => {
        handler({
          payload: { jobId, clientId: 'test-client', status: 'success', strategy: 'npm', activeVersion: '2.0.0' },
        });
      });
      return () => {};
    });

    const clients = new Map([
      [
        'test-client',
        makeInventory({
          clientId: 'test-client',
          installedVersions: [],
          activeVersion: null,
          pinnedVersion: '2.0.0',
        }),
      ],
    ]);

    await activateManagedPins(mockBus.bus, clients);

    expect(mockBus.request).toHaveBeenCalledOnce();
    expect(mockBus.request).toHaveBeenCalledWith(ClientSubjects.update, {
      clientId: 'test-client',
    });
    // Verify the correct subject and jobId filter are passed to bus.on
    expect(mockBus.on).toHaveBeenCalledWith(ClientSubjects.installJob.completed, expect.any(Function), {
      filter: { jobId },
    });
  });

  it('rejects when installJob.completed has status error', async () => {
    const jobId = 'job-fail';
    mockBus.request.mockResolvedValue({ jobId, resolvedVersion: '2.0.0' });

    mockBus.on.mockImplementation((_subject, handler) => {
      void Promise.resolve().then(() => {
        handler({
          payload: {
            jobId,
            clientId: 'test-client',
            status: 'error',
            strategy: 'npm',
            activeVersion: null,
            error: { message: 'disk full' },
          },
        });
      });
      return () => {};
    });

    const clients = new Map([
      [
        'test-client',
        makeInventory({
          clientId: 'test-client',
          installedVersions: [],
          activeVersion: null,
          pinnedVersion: '2.0.0',
        }),
      ],
    ]);

    await expect(activateManagedPins(mockBus.bus, clients)).rejects.toThrow(
      'Binary install failed for test-client: disk full',
    );
  });

  it('uses "unknown error" when error details are absent on failure', async () => {
    const jobId = 'job-fail';
    mockBus.request.mockResolvedValue({ jobId, resolvedVersion: '2.0.0' });

    mockBus.on.mockImplementation((_subject, handler) => {
      void Promise.resolve().then(() => {
        handler({
          payload: {
            jobId,
            clientId: 'test-client',
            status: 'error',
            strategy: 'npm',
            activeVersion: null,
          },
        });
      });
      return () => {};
    });

    const clients = new Map([
      [
        'test-client',
        makeInventory({
          clientId: 'test-client',
          installedVersions: [],
          activeVersion: null,
          pinnedVersion: '2.0.0',
        }),
      ],
    ]);

    await expect(activateManagedPins(mockBus.bus, clients)).rejects.toThrow(
      'Binary install failed for test-client: unknown error',
    );
  });

  it('unsubscribes from installJob.completed after the job resolves', async () => {
    const jobId = 'job-abc';
    const unsubSpy = { called: false };
    const unsub = () => {
      unsubSpy.called = true;
    };

    mockBus.request.mockResolvedValue({ jobId, resolvedVersion: '2.0.0' });
    mockBus.on.mockImplementation((_subject, handler) => {
      void Promise.resolve().then(() => {
        handler({
          payload: { jobId, clientId: 'test-client', status: 'success', strategy: 'npm', activeVersion: '2.0.0' },
        });
      });
      return unsub;
    });

    const clients = new Map([
      [
        'test-client',
        makeInventory({
          clientId: 'test-client',
          installedVersions: [],
          activeVersion: null,
          pinnedVersion: '2.0.0',
        }),
      ],
    ]);

    await activateManagedPins(mockBus.bus, clients);

    expect(unsubSpy.called).toBe(true);
  });

  describe('install timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects with a timeout error and unsubscribes when installJob.completed never fires', async () => {
      vi.useFakeTimers();

      const jobId = 'job-timeout';
      const unsub = vi.fn();

      mockBus.request.mockResolvedValue({ jobId, resolvedVersion: '2.0.0' });
      // bus.on never calls the handler — simulates a stalled install job.
      mockBus.on.mockReturnValue(unsub);

      const clients = new Map([
        [
          'test-client',
          makeInventory({
            clientId: 'test-client',
            installedVersions: [],
            activeVersion: null,
            pinnedVersion: '2.0.0',
          }),
        ],
      ]);

      // Wire up the rejection assertion before advancing time so the
      // unhandled-rejection handler never fires.
      const promise = expect(activateManagedPins(mockBus.bus, clients)).rejects.toThrow(
        'Binary install for test-client timed out after 120s',
      );

      // Advance past the 120-second install timeout.
      await vi.advanceTimersByTimeAsync(120_000);

      await promise;
      expect(unsub).toHaveBeenCalledOnce();
    });
  });
});

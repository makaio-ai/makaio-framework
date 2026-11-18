import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { KernelSubjects, type TransportProvider } from '@makaio/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootMakaioRuntimeCore } from './boot.js';
import { ExplicitDescriptorDiscovery } from './extension-discovery.js';

/** Transport that records whether the boot opened it. */
class RecordingTransport implements TransportProvider {
  public connectCount = 0;
  public disconnectCount = 0;

  public async connect(_bus: IMakaioBus, _machineId: string): Promise<void> {
    this.connectCount += 1;
  }

  public async disconnect(): Promise<void> {
    this.disconnectCount += 1;
  }
}

describe('a boot that is cancelled before it reaches the transport', () => {
  let makaioHome: string;
  const reason = new Error('stop requested');

  beforeEach(async () => {
    makaioHome = await mkdtemp(join(tmpdir(), 'makaio-boot-cancellation-'));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    MakaioBus.__resetHandlers?.();
    vi.restoreAllMocks();
    await rm(makaioHome, { recursive: true, force: true });
  });

  /**
   * Boot against the transport with a signal.
   * @param transport - Transport the boot would open.
   * @param signal - Cancellation of the boot.
   * @returns The boot's outcome.
   */
  function boot(transport: RecordingTransport, signal: AbortSignal): ReturnType<typeof bootMakaioRuntimeCore> {
    return bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      makaioHome,
      discovery: new ExplicitDescriptorDiscovery([]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
      signal,
    });
  }

  it('does not open the transport when the signal is aborted before the boot begins', async () => {
    const transport = new RecordingTransport();

    await expect(boot(transport, AbortSignal.abort(reason))).rejects.toBe(reason);

    expect(transport.connectCount).toBe(0);
  });

  it('does not open the transport when the signal aborts while the bus is being set up', async () => {
    const controller = new AbortController();
    const transport = new RecordingTransport();
    // The phase that precedes the transport: its subscribers run before the connection is made.
    const unsubscribe = MakaioBus.on(KernelSubjects.phase.busCreated, () => controller.abort(reason));

    try {
      await expect(boot(transport, controller.signal)).rejects.toBe(reason);
    } finally {
      unsubscribe();
    }

    expect(transport.connectCount).toBe(0);
  });
});

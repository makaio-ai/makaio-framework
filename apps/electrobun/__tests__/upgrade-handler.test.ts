/**
 * Unit tests for the variant upgrade handler.
 *
 * Tests the `registerVariantUpgradeHandler` bus handler registration and the
 * internal status-mapping logic by driving the mocked Electrobun Updater and
 * asserting on bus progress events.
 *
 * All external I/O (fs, Electrobun Updater, MakaioBus singleton) is mocked so
 * the real handler logic runs without touching the filesystem or process state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatusEntry, UpdateStatusType } from 'electrobun/bun';
import type { RequestContext } from '@makaio/core';
import type {
  VariantRequestUpgradeRequest,
  VariantRequestUpgradeResponse,
  VariantUpgradeStatus,
} from '@makaio/contracts/variant';
import type { VariantConfig } from '../src/variant-config.js';

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

type UpgradeRequestContext = RequestContext<VariantRequestUpgradeRequest, VariantRequestUpgradeResponse>;
type UpgradeRequestHandler = (ctx: UpgradeRequestContext) => void;
type SetResultMock = ReturnType<typeof vi.fn<(result: VariantRequestUpgradeResponse) => void>>;

const busMocks = vi.hoisted(() => ({
  MakaioBus: {
    on: vi.fn<(subject: unknown, handler: UpgradeRequestHandler) => () => void>(),
    emit: vi.fn<(subject: unknown, payload: unknown) => Promise<void>>(),
    /**
     * registerNamespace is called as a side effect by \@makaio/contracts/variant
     * when the namespace module loads. The mock must return a plausible subjects
     * object so the import succeeds without hitting the real bus registry.
     */
    registerNamespace: vi.fn((domain: string, schemas: Record<string, unknown>) => ({
      subjects: Object.fromEntries(
        Object.keys(schemas).map((key) => [
          key,
          { $meta: { namespace: domain, key: `${domain}.${key}`, isRequest: true } },
        ]),
      ),
    })),
  },
}));

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn<(path: string, encoding: BufferEncoding) => string>(),
  writeFileSync: vi.fn<(path: string, data: string, encoding: BufferEncoding) => void>(),
  renameSync: vi.fn<(oldPath: string, newPath: string) => void>(),
}));

const updaterMocks = vi.hoisted(() => {
  let statusChangeCallback: ((entry: UpdateStatusEntry) => void) | null = null;

  return {
    onStatusChange: vi.fn<(callback: ((entry: UpdateStatusEntry) => void) | null) => void>((cb) => {
      statusChangeCallback = cb;
    }),
    checkForUpdate: vi.fn<() => Promise<{ updateAvailable: boolean; error: string; hash: string }>>(),
    downloadUpdate: vi.fn<() => Promise<void>>(),
    updateInfo: vi.fn<() => { updateReady: boolean } | undefined>(),
    applyUpdate: vi.fn<() => Promise<void>>(),
    /**
     * Simulate an Electrobun status event being fired.
     * @param status - Electrobun updater status to emit.
     * @param message - Optional status message.
     * @param details - Optional status details.
     */
    simulateStatus: (status: UpdateStatusType, message = '', details?: UpdateStatusEntry['details']): void => {
      statusChangeCallback?.({ status, message, timestamp: Date.now(), details });
    },
  };
});

vi.mock('@makaio/bus-core', () => ({
  MakaioBus: busMocks.MakaioBus,
}));

vi.mock('node:fs', () => ({
  readFileSync: fsMocks.readFileSync,
  writeFileSync: fsMocks.writeFileSync,
  renameSync: fsMocks.renameSync,
}));

vi.mock('electrobun/bun', () => ({
  Updater: updaterMocks,
}));

// @makaio/contracts/variant is intentionally NOT mocked. The registerNamespace
// side-effect in namespace.ts is handled by the registerNamespace stub on the
// busMocks.MakaioBus mock above, so the real contracts module loads without error.

// Import SUT after mocks are in place.
import { registerVariantUpgradeHandler } from '../src/main/upgrade-handler.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_VARIANT_CONFIG: VariantConfig = {
  variant: 'base',
  releaseTrack: 'stable',
  updateChannel: 'stable',
  bundleCEF: false,
  defaultRenderer: 'native',
};

const CEF_VARIANT_CONFIG: VariantConfig = {
  variant: 'cef',
  releaseTrack: 'stable',
  updateChannel: 'cef',
  bundleCEF: true,
  defaultRenderer: 'cef',
};

const SAMPLE_VERSION_JSON = {
  version: '1.0.0',
  hash: 'abc123',
  baseUrl: 'https://releases.example.com',
  channel: 'stable',
  name: 'Makaio',
  identifier: 'com.makaio.app',
};

/**
 * Build a minimal `RequestContext` stub for the upgrade handler.
 * @param targetVariant - The variant to request an upgrade to.
 * @returns A stubbed context with a `setResult` spy.
 */
function makeRequestCtx(targetVariant: 'base' | 'cef'): UpgradeRequestContext & { setResult: SetResultMock } {
  const setResult = vi.fn<(result: VariantRequestUpgradeResponse) => void>();
  return {
    isRequest: true as const,
    payload: { targetVariant },
    setResult,
    result: undefined,
    extendResult: vi.fn<(extension: Partial<VariantRequestUpgradeResponse>) => void>(),
    next: vi.fn<() => Promise<void>>(),
    replacePayload: vi.fn<(newPayload: VariantRequestUpgradeRequest) => void>(),
    messageId: 'test-message-id',
    correlationId: undefined,
  };
}

/**
 * Register the handler under test and return the captured bus handler function
 * and cleanup array.
 * @param config - Variant config to pass to the handler registration.
 * @returns Object containing the captured handler and the cleanups array.
 */
function setupHandler(config: VariantConfig = BASE_VARIANT_CONFIG): {
  handler: UpgradeRequestHandler;
  cleanups: Array<() => void>;
} {
  const cleanups: Array<() => void> = [];

  // MakaioBus.on returns a cleanup function in production; return a stub.
  busMocks.MakaioBus.on.mockReturnValue(() => undefined);

  registerVariantUpgradeHandler(cleanups, config);

  const capturedHandler = busMocks.MakaioBus.on.mock.calls[0]?.[1];

  if (!capturedHandler) {
    throw new Error('registerVariantUpgradeHandler did not call MakaioBus.on');
  }

  return { handler: capturedHandler, cleanups };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('registerVariantUpgradeHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default fs: version.json readable and writable.
    fsMocks.readFileSync.mockReturnValue(JSON.stringify(SAMPLE_VERSION_JSON));
    fsMocks.writeFileSync.mockReturnValue(undefined);
    fsMocks.renameSync.mockReturnValue(undefined);

    // Default Updater: update available and download succeeds.
    updaterMocks.checkForUpdate.mockResolvedValue({
      updateAvailable: true,
      error: '',
      hash: 'newHash456',
    });
    updaterMocks.downloadUpdate.mockResolvedValue(undefined);
    updaterMocks.updateInfo.mockReturnValue({ updateReady: true });
    updaterMocks.applyUpdate.mockResolvedValue(undefined);

    // Default bus emit: resolves immediately.
    busMocks.MakaioBus.emit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Guard: same-variant rejection ─────────────────────────────────────────

  describe('same-variant rejection', () => {
    it('rejects an upgrade request when target matches the running base variant', () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);
      const ctx = makeRequestCtx('base');

      handler(ctx);

      expect(ctx.setResult).toHaveBeenCalledOnce();
      expect(ctx.setResult).toHaveBeenCalledWith({
        accepted: false,
        message: 'Already on this variant',
      });
    });

    it('rejects an upgrade request when target matches the running cef variant', () => {
      const { handler } = setupHandler(CEF_VARIANT_CONFIG);
      const ctx = makeRequestCtx('cef');

      handler(ctx);

      expect(ctx.setResult).toHaveBeenCalledWith({
        accepted: false,
        message: 'Already on this variant',
      });
    });

    it('does not read version.json when rejecting a same-variant request', () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('base'));

      expect(fsMocks.readFileSync).not.toHaveBeenCalled();
    });
  });

  // ── Guard: concurrent-upgrade rejection ───────────────────────────────────

  describe('concurrent upgrade guard', () => {
    it('accepts the first upgrade and rejects a concurrent second request', async () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      // First request — starts the pipeline in background.
      const ctx1 = makeRequestCtx('cef');
      handler(ctx1);
      expect(ctx1.setResult).toHaveBeenCalledWith(expect.objectContaining({ accepted: true }));

      // Second request arrives before the pipeline completes.
      const ctx2 = makeRequestCtx('cef');
      handler(ctx2);
      expect(ctx2.setResult).toHaveBeenCalledWith({
        accepted: false,
        message: 'An upgrade is already in progress',
      });

      // Drain the background pipeline so the upgradeInProgress flag is reset.
      await vi.waitFor(() => {
        expect(updaterMocks.applyUpdate).toHaveBeenCalled();
      });
    });

    it('allows a new upgrade after the pipeline finishes', async () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      // First request — run pipeline to completion.
      handler(makeRequestCtx('cef'));
      await vi.waitFor(() => expect(updaterMocks.applyUpdate).toHaveBeenCalled());

      // Allow micro-tasks to settle so the .finally() in the handler runs.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Second request should now be accepted.
      const ctx2 = makeRequestCtx('cef');
      handler(ctx2);
      expect(ctx2.setResult).toHaveBeenCalledWith(expect.objectContaining({ accepted: true }));
    });
  });

  // ── version.json read failure ──────────────────────────────────────────────

  describe('version.json read failure', () => {
    it('rejects the request when version.json cannot be read', () => {
      fsMocks.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);
      const ctx = makeRequestCtx('cef');

      handler(ctx);

      expect(ctx.setResult).toHaveBeenCalledWith({
        accepted: false,
        message: expect.stringContaining('ENOENT: no such file'),
      });
    });

    it('does not start the pipeline when version.json cannot be read', () => {
      fsMocks.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      expect(updaterMocks.checkForUpdate).not.toHaveBeenCalled();
    });
  });

  // ── version.json write (channel rewrite) ──────────────────────────────────

  describe('version.json channel rewrite', () => {
    it('rewrites channel to "cef" when upgrading base → cef', () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      // writeFileSync writes to a .tmp path first; renameSync completes the atomic swap.
      expect(fsMocks.writeFileSync).toHaveBeenCalledOnce();
      const writtenContent = fsMocks.writeFileSync.mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(writtenContent) as { channel: string };
      expect(parsed.channel).toBe('cef');
    });

    it('rewrites channel to "stable" when upgrading cef → base', () => {
      const versionJson = { ...SAMPLE_VERSION_JSON, channel: 'cef' };
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(versionJson));
      const { handler } = setupHandler(CEF_VARIANT_CONFIG);

      handler(makeRequestCtx('base'));

      const writtenContent = fsMocks.writeFileSync.mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(writtenContent) as { channel: string };
      expect(parsed.channel).toBe('stable');
    });

    it('preserves all other version.json fields when rewriting channel', () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      const writtenContent = fsMocks.writeFileSync.mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(writtenContent) as typeof SAMPLE_VERSION_JSON;
      expect(parsed.version).toBe(SAMPLE_VERSION_JSON.version);
      expect(parsed.hash).toBe(SAMPLE_VERSION_JSON.hash);
      expect(parsed.baseUrl).toBe(SAMPLE_VERSION_JSON.baseUrl);
      expect(parsed.name).toBe(SAMPLE_VERSION_JSON.name);
      expect(parsed.identifier).toBe(SAMPLE_VERSION_JSON.identifier);
    });

    it('uses an atomic write (tmp + rename) for version.json', () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      // writeFileSync is called with a ".tmp" suffix path.
      const writePath = fsMocks.writeFileSync.mock.calls[0]?.[0] as string;
      expect(writePath).toMatch(/\.tmp$/);

      // renameSync renames .tmp → the real path.
      const [oldPath, newPath] = fsMocks.renameSync.mock.calls[0] as [string, string];
      expect(oldPath).toMatch(/\.tmp$/);
      expect(newPath).not.toMatch(/\.tmp$/);
      expect(newPath).toMatch(/version\.json$/);
    });

    it('rejects the request when version.json cannot be written', () => {
      fsMocks.writeFileSync.mockImplementation(() => {
        throw new Error('EROFS: read-only filesystem');
      });
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);
      const ctx = makeRequestCtx('cef');

      handler(ctx);

      expect(ctx.setResult).toHaveBeenCalledWith({
        accepted: false,
        message: expect.stringContaining('EROFS: read-only filesystem'),
      });
      expect(updaterMocks.checkForUpdate).not.toHaveBeenCalled();
    });
  });

  // ── Accepted upgrade ──────────────────────────────────────────────────────

  describe('accepted upgrade response', () => {
    it('returns accepted: true for a valid upgrade from base to cef', () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);
      const ctx = makeRequestCtx('cef');

      handler(ctx);

      expect(ctx.setResult).toHaveBeenCalledOnce();
      const result = ctx.setResult.mock.calls[0]?.[0] as { accepted: boolean };
      expect(result.accepted).toBe(true);
    });

    it('returns accepted: true for a valid upgrade from cef to base', () => {
      fsMocks.readFileSync.mockReturnValue(JSON.stringify({ ...SAMPLE_VERSION_JSON, channel: 'cef' }));
      const { handler } = setupHandler(CEF_VARIANT_CONFIG);
      const ctx = makeRequestCtx('base');

      handler(ctx);

      const result = ctx.setResult.mock.calls[0]?.[0] as { accepted: boolean };
      expect(result.accepted).toBe(true);
    });
  });

  // ── Pipeline: progress events ──────────────────────────────────────────────

  describe('upgrade pipeline progress events', () => {
    it('emits a downloading progress event when the pipeline starts', async () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      await vi.waitFor(() => expect(busMocks.MakaioBus.emit).toHaveBeenCalled());

      const firstEmitPayload = busMocks.MakaioBus.emit.mock.calls[0]?.[1] as {
        status: VariantUpgradeStatus;
        percent?: number;
        message?: string;
      };
      expect(firstEmitPayload.status).toBe('downloading');
      expect(firstEmitPayload.percent).toBe(0);
      expect(firstEmitPayload.message).toContain('cef');
    });

    it('emits an applying event before applying the update', async () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      await vi.waitFor(() => expect(updaterMocks.applyUpdate).toHaveBeenCalled());

      const allEmittedStatuses = busMocks.MakaioBus.emit.mock.calls.map(
        (call) => (call[1] as { status: VariantUpgradeStatus }).status,
      );
      expect(allEmittedStatuses).toContain('applying');
    });

    it('emits a complete event when applyUpdate resolves (defensive path)', async () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      // Use expect inside waitFor so it throws and retries until 'complete' is emitted.
      await vi.waitFor(() => {
        const statuses = busMocks.MakaioBus.emit.mock.calls.map(
          (call) => (call[1] as { status: VariantUpgradeStatus }).status,
        );
        expect(statuses).toContain('complete');
      });
    });

    it('emits an error event when checkForUpdate fails', async () => {
      updaterMocks.checkForUpdate.mockResolvedValue({
        updateAvailable: false,
        error: 'network timeout',
        hash: '',
      });
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      await vi.waitFor(() => {
        const statuses = busMocks.MakaioBus.emit.mock.calls.map(
          (call) => (call[1] as { status: VariantUpgradeStatus }).status,
        );
        expect(statuses).toContain('error');
      });
    });

    it('emits an error event when updateAvailable is false', async () => {
      updaterMocks.checkForUpdate.mockResolvedValue({
        updateAvailable: false,
        error: '',
        hash: '',
      });
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      await vi.waitFor(() => {
        const statuses = busMocks.MakaioBus.emit.mock.calls.map(
          (call) => (call[1] as { status: VariantUpgradeStatus }).status,
        );
        expect(statuses).toContain('error');
      });

      const errorPayload = busMocks.MakaioBus.emit.mock.calls.find(
        (call) => (call[1] as { status: VariantUpgradeStatus }).status === 'error',
      )?.[1] as { status: VariantUpgradeStatus; message?: string };
      expect(errorPayload?.message).toContain('No update available on channel');
    });

    it('emits an error event when download did not complete (updateReady is false)', async () => {
      updaterMocks.updateInfo.mockReturnValue({ updateReady: false });
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      await vi.waitFor(() => {
        const statuses = busMocks.MakaioBus.emit.mock.calls.map(
          (call) => (call[1] as { status: VariantUpgradeStatus }).status,
        );
        expect(statuses).toContain('error');
      });
    });
  });

  // ── Pipeline: version.json restoration on failure ─────────────────────────

  describe('version.json restoration on pipeline failure', () => {
    it('restores the original version.json when the upgrade pipeline throws', async () => {
      updaterMocks.checkForUpdate.mockRejectedValue(new Error('pipeline exploded'));
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);
      const originalContent = JSON.stringify(SAMPLE_VERSION_JSON);

      handler(makeRequestCtx('cef'));

      // Wait for the error path to run (error event emitted).
      await vi.waitFor(() => {
        const statuses = busMocks.MakaioBus.emit.mock.calls.map(
          (call) => (call[1] as { status: VariantUpgradeStatus }).status,
        );
        expect(statuses).toContain('error');
      });
      // Allow the finally block to finish.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The second writeFileSync + renameSync pair should be the restore write.
      // (First pair is the initial channel rewrite; second pair is the restore.)
      expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(2);

      const restoreWriteContent = fsMocks.writeFileSync.mock.calls[1]?.[1] as string;
      expect(restoreWriteContent).toBe(originalContent);
    });

    it('clears the Updater status callback via onStatusChange(null) after failure', async () => {
      updaterMocks.checkForUpdate.mockRejectedValue(new Error('download failure'));
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      await vi.waitFor(() => {
        const statuses = busMocks.MakaioBus.emit.mock.calls.map(
          (call) => (call[1] as { status: VariantUpgradeStatus }).status,
        );
        expect(statuses).toContain('error');
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // onStatusChange must be called twice: once to register, once to clear.
      expect(updaterMocks.onStatusChange).toHaveBeenCalledWith(null);
    });

    it('clears the Updater status callback via onStatusChange(null) on success', async () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      await vi.waitFor(() => expect(updaterMocks.applyUpdate).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(updaterMocks.onStatusChange).toHaveBeenCalledWith(null);
    });

    it('does not restore version.json when the pipeline succeeds', async () => {
      const { handler } = setupHandler(BASE_VARIANT_CONFIG);

      handler(makeRequestCtx('cef'));

      await vi.waitFor(() => expect(updaterMocks.applyUpdate).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Only the initial atomic write — no restore write.
      expect(fsMocks.writeFileSync).toHaveBeenCalledOnce();
    });
  });

  // ── Electrobun status-to-bus-phase mapping ────────────────────────────────

  describe('Electrobun status-to-bus-phase mapping', () => {
    /**
     * Drive `Updater.onStatusChange` callbacks from within the pipeline and
     * assert that the correct coarse bus status phase is emitted.
     * @param electrobunStatus - Raw Electrobun updater status to simulate.
     * @param expectedBusStatus - Expected coarse bus phase.
     */
    async function assertStatusMapsTo(
      electrobunStatus: UpdateStatusType,
      expectedBusStatus: VariantUpgradeStatus,
    ): Promise<void> {
      vi.clearAllMocks();
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(SAMPLE_VERSION_JSON));
      fsMocks.writeFileSync.mockReturnValue(undefined);
      fsMocks.renameSync.mockReturnValue(undefined);
      busMocks.MakaioBus.emit.mockResolvedValue(undefined);
      busMocks.MakaioBus.on.mockReturnValue(() => undefined);

      updaterMocks.checkForUpdate.mockResolvedValue({ updateAvailable: true, error: '', hash: 'h2' });
      updaterMocks.downloadUpdate.mockImplementation(async () => {
        updaterMocks.simulateStatus(electrobunStatus, 'test-message', { progress: 42 });
      });
      updaterMocks.updateInfo.mockReturnValue({ updateReady: true });
      updaterMocks.applyUpdate.mockResolvedValue(undefined);

      const cleanups: Array<() => void> = [];
      registerVariantUpgradeHandler(cleanups, BASE_VARIANT_CONFIG);

      const capturedHandler = busMocks.MakaioBus.on.mock.calls[0]?.[1];
      if (!capturedHandler) {
        throw new Error('registerVariantUpgradeHandler did not call MakaioBus.on');
      }

      const ctx = makeRequestCtx('cef');
      capturedHandler(ctx);

      await vi.waitFor(() => expect(updaterMocks.applyUpdate).toHaveBeenCalled());

      const emittedStatuses = busMocks.MakaioBus.emit.mock.calls.map(
        (call) => (call[1] as { status: VariantUpgradeStatus }).status,
      );
      expect(emittedStatuses).toContain(expectedBusStatus);
    }

    // ── downloading group ──────────────────────────────────────────────────

    it.each<[UpdateStatusType, VariantUpgradeStatus]>([
      ['checking', 'downloading'],
      ['downloading', 'downloading'],
      ['download-starting', 'downloading'],
      ['checking-local-tar', 'downloading'],
      ['local-tar-found', 'downloading'],
      ['local-tar-missing', 'downloading'],
      ['fetching-patch', 'downloading'],
      ['patch-found', 'downloading'],
      ['patch-not-found', 'downloading'],
      ['downloading-full-bundle', 'downloading'],
    ])('maps Electrobun "%s" → bus "downloading"', async (electrobunStatus, expectedBusStatus) => {
      await assertStatusMapsTo(electrobunStatus, expectedBusStatus);
    });

    // ── progress group ─────────────────────────────────────────────────────

    it.each<[UpdateStatusType, VariantUpgradeStatus]>([
      ['downloading-patch', 'progress'],
      ['download-progress', 'progress'],
      ['applying-patch', 'progress'],
      ['patch-applied', 'progress'],
      ['patch-chain-complete', 'progress'],
      ['extracting-version', 'progress'],
      ['decompressing', 'progress'],
      ['download-complete', 'progress'],
    ])('maps Electrobun "%s" → bus "progress"', async (electrobunStatus, expectedBusStatus) => {
      await assertStatusMapsTo(electrobunStatus, expectedBusStatus);
    });

    // ── applying group ─────────────────────────────────────────────────────

    it.each<[UpdateStatusType, VariantUpgradeStatus]>([
      ['applying', 'applying'],
      ['extracting', 'applying'],
      ['replacing-app', 'applying'],
      ['launching-new-version', 'applying'],
    ])('maps Electrobun "%s" → bus "applying"', async (electrobunStatus, expectedBusStatus) => {
      await assertStatusMapsTo(electrobunStatus, expectedBusStatus);
    });

    // ── complete group ─────────────────────────────────────────────────────

    it.each<[UpdateStatusType, VariantUpgradeStatus]>([
      ['complete', 'complete'],
      ['check-complete', 'complete'],
      ['no-update', 'complete'],
      ['update-available', 'complete'],
    ])('maps Electrobun "%s" → bus "complete"', async (electrobunStatus, expectedBusStatus) => {
      await assertStatusMapsTo(electrobunStatus, expectedBusStatus);
    });

    // ── error group ────────────────────────────────────────────────────────

    it.each<[UpdateStatusType, VariantUpgradeStatus]>([
      ['error', 'error'],
      ['patch-failed', 'error'],
    ])('maps Electrobun "%s" → bus "error"', async (electrobunStatus, expectedBusStatus) => {
      await assertStatusMapsTo(electrobunStatus, expectedBusStatus);
    });

    it('suppresses unmapped Electrobun statuses (e.g. "idle")', async () => {
      vi.clearAllMocks();
      fsMocks.readFileSync.mockReturnValue(JSON.stringify(SAMPLE_VERSION_JSON));
      fsMocks.writeFileSync.mockReturnValue(undefined);
      fsMocks.renameSync.mockReturnValue(undefined);
      busMocks.MakaioBus.emit.mockResolvedValue(undefined);
      busMocks.MakaioBus.on.mockReturnValue(() => undefined);

      updaterMocks.checkForUpdate.mockResolvedValue({ updateAvailable: true, error: '', hash: 'h2' });
      updaterMocks.downloadUpdate.mockImplementation(async () => {
        // 'idle' is not in the mapping table and must be suppressed.
        updaterMocks.simulateStatus('idle', 'idle state');
      });
      updaterMocks.updateInfo.mockReturnValue({ updateReady: true });
      updaterMocks.applyUpdate.mockResolvedValue(undefined);

      const cleanups: Array<() => void> = [];
      registerVariantUpgradeHandler(cleanups, BASE_VARIANT_CONFIG);

      const capturedHandler = busMocks.MakaioBus.on.mock.calls[0]?.[1];
      if (!capturedHandler) {
        throw new Error('registerVariantUpgradeHandler did not call MakaioBus.on');
      }

      capturedHandler(makeRequestCtx('cef'));
      await vi.waitFor(() => expect(updaterMocks.applyUpdate).toHaveBeenCalled());

      const emittedStatuses = busMocks.MakaioBus.emit.mock.calls.map(
        (call) => (call[1] as { status: VariantUpgradeStatus }).status,
      );

      // 'idle' must never appear as a bus-level status.
      expect(emittedStatuses).not.toContain('idle');
    });
  });

  // ── Cleanup registration ───────────────────────────────────────────────────

  describe('cleanup registration', () => {
    it('pushes a cleanup callback into the cleanups array', () => {
      const cleanups: Array<() => void> = [];
      busMocks.MakaioBus.on.mockReturnValue(() => undefined);

      registerVariantUpgradeHandler(cleanups, BASE_VARIANT_CONFIG);

      expect(cleanups).toHaveLength(1);
      expect(typeof cleanups[0]).toBe('function');
    });
  });
});

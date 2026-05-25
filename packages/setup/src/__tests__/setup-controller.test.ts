/**
 * Tests for {@link createSetupController}.
 *
 * Covers initial state derivation, consent acceptance, client selection,
 * the full install orchestration flow, error handling, and onChange
 * listener notifications.
 *
 * Real filesystem operations (consent read/write) use a per-test temporary
 * directory so tests remain isolated and never touch the user's home directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockBus, type MockBusResult } from '@makaio/test-utils';
import { PackageSubjects } from '@makaio/services-package-manager';
import { ClientSubjects } from '@makaio/contracts/client';
import { KernelSubjects } from '@makaio/kernel';
import { writeConsentRecord, loadConsentDocument } from '../index.js';
import { createSetupController as createRawSetupController } from '../setup-controller.js';
import type { SetupController, SetupState } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string | null = null;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'makaio-setup-ctrl-test-'));
  return tempDir;
}

afterEach(async () => {
  if (tempDir !== null) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

/**
 * Resolves the real terms document hash for pre-writing valid consent records
 * in tests that need to skip the consent step.
 * @returns The SHA-256 hash of the bundled terms document.
 */
async function getRealTermsHash(): Promise<string> {
  const doc = await loadConsentDocument();
  return doc.hash;
}

/**
 * Toggles a client selection through the public setup action seam.
 * @param controller - Setup controller under test.
 * @param clientId - Client ID to toggle.
 */
function toggleSelection(controller: SetupController, clientId: string): void {
  controller.actions.setClientSelected(clientId, !controller.state.selectedClientIds.includes(clientId));
}

/**
 * Creates a setup controller with a test restart seam that returns the same bus.
 * Tests that need to assert fresh-bus behavior pass their own seam explicitly.
 * @param config - Controller config without restart seam.
 */
async function createSetupController(
  config: Omit<Parameters<typeof createRawSetupController>[0], 'restartAndReconnect'> &
    Partial<Pick<Parameters<typeof createRawSetupController>[0], 'restartAndReconnect'>>,
): ReturnType<typeof createRawSetupController> {
  return await createRawSetupController({
    ...config,
    restartAndReconnect: config.restartAndReconnect ?? (async (bus) => bus),
  });
}

// ---------------------------------------------------------------------------
// Minimal bus response builder for the full install flow
// ---------------------------------------------------------------------------

/**
 * Configures the mock bus to respond successfully to all subjects invoked
 * during `installSelectedClients()` for a single package / no managed pins.
 * @param mockBus - The mock bus result to configure.
 * @param packageName - Extension package name to simulate being installed.
 */
function setupFullInstallResponses(mockBus: MockBusResult, packageName: string): void {
  mockBus.request.mockImplementation((subject: unknown) => {
    if (subject === PackageSubjects.list) {
      return Promise.resolve({ packages: [] });
    }
    if (subject === PackageSubjects.install) {
      return Promise.resolve({
        success: true,
        packageName,
        restartRequired: true,
      });
    }
    if (subject === KernelSubjects.restart) {
      return Promise.resolve({ accepted: true });
    }
    if (subject === ClientSubjects.scan) {
      return Promise.resolve({ results: [] });
    }
    if (subject === ClientSubjects.list) {
      return Promise.resolve({ clients: [] });
    }
    return Promise.resolve({});
  });
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('createSetupController — initial state', () => {
  it('starts at consent step when no consent record exists', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();

    const controller = await createSetupController({ bus, makaioHome: dir });

    expect(controller.state.step).toBe('consent');
    expect(controller.state.consentAccepted).toBe(false);
  });

  it('exposes the terms text, version, and hash from the loaded document', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();
    const doc = await loadConsentDocument();

    const controller = await createSetupController({ bus, makaioHome: dir });

    expect(controller.state.termsText).toBe(doc.text);
    expect(controller.state.termsVersion).toBe(doc.version);
    expect(controller.state.termsHash).toBe(doc.hash);
  });

  it('initialises with empty clients, progress, and null result/error', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();

    const controller = await createSetupController({ bus, makaioHome: dir });

    expect(controller.state.detectedClients).toHaveLength(0);
    expect(controller.state.selectedClientIds).toHaveLength(0);
    expect(controller.state.extensionInstallProgress).toHaveLength(0);
    expect(controller.state.managedBinaryStates).toHaveLength(0);
    expect(controller.state.restartRequested).toBe(false);
    expect(controller.state.result).toBeNull();
    expect(controller.state.error).toBeNull();
  });

  it('exposes the planned controller navigation and actions seam', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();

    const controller = await createSetupController({ bus, makaioHome: dir });

    expect(typeof controller.canAdvance).toBe('function');
    expect(typeof controller.back).toBe('function');
    expect(controller.actions).toEqual({
      acceptConsent: expect.any(Function),
      setClientSelected: expect.any(Function),
      installSelectedClients: expect.any(Function),
      setManifestExtensionSelected: expect.any(Function),
      installSelectedManifestAndClients: expect.any(Function),
    });
  });
});

// ---------------------------------------------------------------------------
// Auto-advance when consent already accepted
// ---------------------------------------------------------------------------

describe('createSetupController — pre-accepted consent', () => {
  it('starts at detect step when an existing consent record matches the document hash', async () => {
    const dir = await makeTempDir();
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    expect(controller.state.step).toBe('detect');
    expect(controller.state.consentAccepted).toBe(true);
  });

  it('stays at consent when an existing record has a non-matching hash', async () => {
    const dir = await makeTempDir();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: 'a'.repeat(64),
      documentVersion: '2000-01-01',
    });

    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    expect(controller.state.step).toBe('consent');
    expect(controller.state.consentAccepted).toBe(false);
  });

  it('populates detectedClients when starting at detect step', async () => {
    const dir = await makeTempDir();
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    // Detection always runs for all 5 catalog entries even if none are found
    expect(controller.state.detectedClients).toHaveLength(5);
  });

  it('pre-populates selectedClientIds with clientIds of detected clients', async () => {
    const dir = await makeTempDir();
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    const detectedIds = controller.state.detectedClients.filter((d) => d.detected).map((d) => d.entry.clientId);
    expect(controller.state.selectedClientIds).toEqual(detectedIds);
  });
});

// ---------------------------------------------------------------------------
// advance()
// ---------------------------------------------------------------------------

describe('advance()', () => {
  let mockBus: MockBusResult;
  let dir: string;

  beforeEach(async () => {
    mockBus = createMockBus();
    dir = await makeTempDir();
  });

  it('writes a consent.json file to makaioHome', async () => {
    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    await controller.advance();

    const raw = await readFile(join(dir, 'consent.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof parsed['acceptedAt']).toBe('string');
    expect(parsed['documentHash']).toBe(controller.state.termsHash);
  });

  it('transitions to the detect step after accepting', async () => {
    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    await controller.advance();

    expect(controller.state.step).toBe('detect');
    expect(controller.state.consentAccepted).toBe(true);
  });

  it('populates detectedClients from the catalog after advancing', async () => {
    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    await controller.advance();

    // Should have one entry per catalog client (5 total)
    expect(controller.state.detectedClients).toHaveLength(5);
    // Each entry must have an `entry` with a clientId and a boolean `detected`
    for (const dc of controller.state.detectedClients) {
      expect(typeof dc.entry.clientId).toBe('string');
      expect(typeof dc.detected).toBe('boolean');
    }
  });

  it('acceptConsent is a no-op when called outside the consent step', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });
    // Already at detect
    expect(controller.state.step).toBe('detect');

    const stateBeforeCall = controller.state;
    await controller.actions.acceptConsent();

    expect(controller.state).toBe(stateBeforeCall);
  });
});

// ---------------------------------------------------------------------------
// setClientSelected()
// ---------------------------------------------------------------------------

describe('setClientSelected()', () => {
  it('removes a client from selectedClientIds when it is currently selected', async () => {
    const dir = await makeTempDir();
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    const firstDetected = controller.state.detectedClients.find((d) => d.detected);
    if (firstDetected === undefined) {
      // No clients detected on this machine — seed a selection manually by
      // toggling an undetected client in.
      const { clientId } = controller.state.detectedClients[0].entry;
      toggleSelection(controller, clientId);
      expect(controller.state.selectedClientIds).toContain(clientId);
      toggleSelection(controller, clientId);
      expect(controller.state.selectedClientIds).not.toContain(clientId);
      return;
    }

    const { clientId } = firstDetected.entry;
    expect(controller.state.selectedClientIds).toContain(clientId);

    toggleSelection(controller, clientId);
    expect(controller.state.selectedClientIds).not.toContain(clientId);

    toggleSelection(controller, clientId);
    expect(controller.state.selectedClientIds).toContain(clientId);
  });

  it('adds a client to selectedClientIds when it is not currently selected', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    // Force to detect step
    await controller.advance();

    const clientId = controller.state.detectedClients[0].entry.clientId;
    // Ensure it's not selected
    if (controller.state.selectedClientIds.includes(clientId)) {
      toggleSelection(controller, clientId);
    }
    expect(controller.state.selectedClientIds).not.toContain(clientId);

    toggleSelection(controller, clientId);
    expect(controller.state.selectedClientIds).toContain(clientId);
  });

  it('is a no-op when called outside the detect step', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    // Still at consent step
    expect(controller.state.step).toBe('consent');
    const stateBefore = controller.state;
    toggleSelection(controller, 'claude-code');

    expect(controller.state).toBe(stateBefore);
  });
});

// ---------------------------------------------------------------------------
// installSelectedClients()
// ---------------------------------------------------------------------------

describe('installSelectedClients()', () => {
  let mockBus: MockBusResult;
  let dir: string;

  beforeEach(async () => {
    mockBus = createMockBus();
    dir = await makeTempDir();
  });

  it('progresses through install → managed → complete on success', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    // Force one selected client so at least one package gets "installed"
    const firstEntry = controller.state.detectedClients[0].entry;
    if (!controller.state.selectedClientIds.includes(firstEntry.clientId)) {
      toggleSelection(controller, firstEntry.clientId);
    }

    const packageName = firstEntry.extensionPackages[0];
    setupFullInstallResponses(mockBus, packageName);

    const steps: string[] = [];
    controller.onChange((s) => steps.push(s.step));

    await controller.actions.installSelectedClients();

    expect(steps).toContain('install');
    expect(steps).toContain('managed');
    expect(steps).toContain('complete');
    expect(controller.state.step).toBe('complete');
  });

  it('sets result.success to true on successful completion', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    setupFullInstallResponses(mockBus, '@makaio/some-package');

    await controller.actions.installSelectedClients();

    expect(controller.state.result).not.toBeNull();
    expect(controller.state.result?.success).toBe(true);
    expect(controller.state.error).toBeNull();
  });

  it('is a no-op when called outside the detect step', async () => {
    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    // Still at consent
    expect(controller.state.step).toBe('consent');
    const stateBefore = controller.state;

    await controller.actions.installSelectedClients();

    expect(controller.state).toBe(stateBefore);
    expect(mockBus.request).not.toHaveBeenCalled();
  });

  it('completes immediately when no clients are selected', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    // Deselect all clients so the package list is empty
    for (const { entry } of controller.state.detectedClients) {
      if (controller.state.selectedClientIds.includes(entry.clientId)) {
        toggleSelection(controller, entry.clientId);
      }
    }
    expect(controller.state.selectedClientIds).toHaveLength(0);

    await controller.actions.installSelectedClients();

    expect(controller.state.step).toBe('complete');
    expect(controller.state.result?.success).toBe(true);
    expect(controller.state.result?.installedPackages).toHaveLength(0);
    expect(controller.state.result?.activatedBinaries).toHaveLength(0);
    expect(mockBus.request).not.toHaveBeenCalled();
  });

  it('sets error state when package installation fails', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    // Ensure at least one package is selected
    const firstEntry = controller.state.detectedClients[0].entry;
    if (!controller.state.selectedClientIds.includes(firstEntry.clientId)) {
      toggleSelection(controller, firstEntry.clientId);
    }

    mockBus.request.mockResolvedValue({
      success: false,
      packageName: firstEntry.extensionPackages[0],
      restartRequired: false,
      error: 'registry unavailable',
    });

    await controller.actions.installSelectedClients();

    expect(controller.state.error).toMatch(/registry unavailable/);
    expect(controller.state.result).toBeNull();
    expect(controller.state.step).toBe('detect');
  });

  it('clears stale errors when a retry completes successfully', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });
    const firstEntry = controller.state.detectedClients[0].entry;
    if (!controller.state.selectedClientIds.includes(firstEntry.clientId)) {
      toggleSelection(controller, firstEntry.clientId);
    }

    mockBus.request.mockResolvedValueOnce({
      success: false,
      packageName: firstEntry.extensionPackages[0],
      restartRequired: false,
      error: 'registry unavailable',
    });

    await controller.actions.installSelectedClients();
    expect(controller.state.error).toMatch(/registry unavailable/);

    setupFullInstallResponses(mockBus, firstEntry.extensionPackages[0]);

    await controller.actions.installSelectedClients();

    expect(controller.state.step).toBe('complete');
    expect(controller.state.error).toBeNull();
  });

  it('sets error state when the kernel restart is declined', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    // Ensure at least one client is selected so the install flow reaches the
    // kernel restart step rather than short-circuiting on an empty package list.
    const firstEntry = controller.state.detectedClients[0].entry;
    if (!controller.state.selectedClientIds.includes(firstEntry.clientId)) {
      toggleSelection(controller, firstEntry.clientId);
    }

    mockBus.request.mockImplementation((subject: unknown) => {
      if (subject === PackageSubjects.install) {
        return Promise.resolve({
          success: true,
          packageName: 'pkg',
          restartRequired: true,
        });
      }
      return Promise.resolve({});
    });
    const controllerWithDeclinedRestart = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      restartAndReconnect: async () => {
        throw new Error('Kernel restart was not accepted by the host');
      },
    });
    if (!controllerWithDeclinedRestart.state.selectedClientIds.includes(firstEntry.clientId)) {
      toggleSelection(controllerWithDeclinedRestart, firstEntry.clientId);
    }

    await controllerWithDeclinedRestart.actions.installSelectedClients();

    expect(controllerWithDeclinedRestart.state.error).toMatch(/not accepted/);
    expect(controllerWithDeclinedRestart.state.step).toBe('detect');
  });

  it('uses the reconnected bus for post-restart client inventory and activation', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });
    const freshBus = createMockBus();

    mockBus.request.mockImplementation((subject: unknown) => {
      if (subject === PackageSubjects.install) {
        return Promise.resolve({
          success: true,
          packageName: '@makaio/client-claude-code',
          restartRequired: true,
        });
      }
      return Promise.resolve({});
    });
    freshBus.request.mockImplementation((subject: unknown) => {
      if (subject === ClientSubjects.scan) {
        return Promise.resolve({ results: [] });
      }
      if (subject === ClientSubjects.list) {
        return Promise.resolve({
          clients: [
            {
              clientId: 'claude-code',
              installedVersions: [{ version: '1.0.0', installPath: '/selected', installedAt: 0, isActive: false }],
              activeVersion: null,
              pinnedVersion: '1.0.0',
              updateAvailable: true,
            },
          ],
        });
      }
      if (subject === ClientSubjects.setActive) {
        return Promise.resolve({ clientId: 'claude-code', activeVersion: '1.0.0' });
      }
      return Promise.resolve({});
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      restartAndReconnect: async () => freshBus.bus,
    });
    for (const { entry } of controller.state.detectedClients) {
      const selected = controller.state.selectedClientIds.includes(entry.clientId);
      if (entry.clientId === 'claude-code' && !selected) toggleSelection(controller, entry.clientId);
      if (entry.clientId !== 'claude-code' && selected) toggleSelection(controller, entry.clientId);
    }

    await controller.actions.installSelectedClients();

    expect(mockBus.request).not.toHaveBeenCalledWith(ClientSubjects.scan, expect.anything());
    expect(mockBus.request).not.toHaveBeenCalledWith(ClientSubjects.list, expect.anything());
    expect(freshBus.request).toHaveBeenCalledWith(ClientSubjects.scan, {
      targets: [{ clientId: 'claude-code', binaryName: 'claude' }],
    });
    expect(freshBus.request).toHaveBeenCalledWith(ClientSubjects.list, {});
    expect(freshBus.request).toHaveBeenCalledWith(ClientSubjects.setActive, {
      clientId: 'claude-code',
      version: '1.0.0',
    });
  });

  it('uses the existing bus and skips restart when installed packages do not require restart', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });
    const restartAndReconnect = vi.fn(async () => {
      throw new Error('restart should not be called');
    });
    mockBus.request.mockImplementation((subject: unknown) => {
      if (subject === PackageSubjects.install) {
        return Promise.resolve({
          success: true,
          packageName: '@makaio/client-claude-code',
          restartRequired: false,
        });
      }
      if (subject === ClientSubjects.scan) {
        return Promise.resolve({ results: [] });
      }
      if (subject === ClientSubjects.list) {
        return Promise.resolve({ clients: [] });
      }
      return Promise.resolve({});
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      restartAndReconnect,
    });
    for (const { entry } of controller.state.detectedClients) {
      const selected = controller.state.selectedClientIds.includes(entry.clientId);
      if (entry.clientId === 'claude-code' && !selected) toggleSelection(controller, entry.clientId);
      if (entry.clientId !== 'claude-code' && selected) toggleSelection(controller, entry.clientId);
    }

    await controller.actions.installSelectedClients();

    expect(restartAndReconnect).not.toHaveBeenCalled();
    expect(controller.state.restartRequested).toBe(false);
    expect(mockBus.request).toHaveBeenCalledWith(ClientSubjects.scan, {
      targets: [{ clientId: 'claude-code', binaryName: 'claude' }],
    });
  });

  it('activates managed binaries only for selected clients', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    const [selectedEntry, unselectedEntry] = controller.state.detectedClients.map((client) => client.entry);
    for (const { entry } of controller.state.detectedClients) {
      const selected = controller.state.selectedClientIds.includes(entry.clientId);
      if (entry.clientId === selectedEntry.clientId && !selected) {
        toggleSelection(controller, entry.clientId);
      }
      if (entry.clientId !== selectedEntry.clientId && selected) {
        toggleSelection(controller, entry.clientId);
      }
    }

    mockBus.request.mockImplementation((subject: unknown) => {
      if (subject === PackageSubjects.install) {
        return Promise.resolve({
          success: true,
          packageName: selectedEntry.extensionPackages[0],
          restartRequired: true,
        });
      }
      if (subject === KernelSubjects.restart) {
        return Promise.resolve({ accepted: true });
      }
      if (subject === ClientSubjects.scan) {
        return Promise.resolve({ results: [] });
      }
      if (subject === ClientSubjects.list) {
        return Promise.resolve({
          clients: [
            {
              clientId: selectedEntry.clientId,
              installedVersions: [{ version: '1.0.0', installPath: '/selected', installedAt: 0, isActive: false }],
              activeVersion: null,
              pinnedVersion: '1.0.0',
              updateAvailable: true,
            },
            {
              clientId: unselectedEntry.clientId,
              installedVersions: [{ version: '2.0.0', installPath: '/unselected', installedAt: 0, isActive: false }],
              activeVersion: null,
              pinnedVersion: '2.0.0',
              updateAvailable: true,
            },
          ],
        });
      }
      if (subject === ClientSubjects.setActive) {
        return Promise.resolve({ clientId: 'unused', activeVersion: 'unused' });
      }
      return Promise.resolve({});
    });

    await controller.actions.installSelectedClients();

    const setActiveCalls = mockBus.request.mock.calls.filter(([subject]) => subject === ClientSubjects.setActive);
    expect(setActiveCalls).toHaveLength(1);
    expect(setActiveCalls[0][1]).toEqual({ clientId: selectedEntry.clientId, version: '1.0.0' });
  });
});

// ---------------------------------------------------------------------------
// onChange notifications
// ---------------------------------------------------------------------------

describe('onChange()', () => {
  it('notifies listener with each state change during advance()', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    const captured: SetupState[] = [];
    controller.onChange((s) => captured.push(s));

    await controller.advance();

    expect(captured.length).toBeGreaterThan(0);
    const last = captured[captured.length - 1];
    expect(last.step).toBe('detect');
  });

  it('does not notify after the listener is unsubscribed', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    const captured: SetupState[] = [];
    const unsub = controller.onChange((s) => captured.push(s));

    await controller.advance();
    const countAfterAdvance = captured.length;

    unsub();
    // setClientSelected triggers another setState — should not reach the listener
    toggleSelection(controller, 'claude-code');

    expect(captured.length).toBe(countAfterAdvance);
  });

  it('can have multiple listeners registered simultaneously', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    const callsA = vi.fn();
    const callsB = vi.fn();
    controller.onChange(callsA);
    controller.onChange(callsB);

    await controller.advance();

    expect(callsA).toHaveBeenCalled();
    expect(callsB).toHaveBeenCalled();
    expect(callsA.mock.calls.length).toBe(callsB.mock.calls.length);
  });

  it('state getter reflects the latest state after each change', async () => {
    const dir = await makeTempDir();
    const { bus } = createMockBus();
    const controller = await createSetupController({ bus, makaioHome: dir });

    controller.onChange((s) => {
      // Each time a listener fires, the getter must return the same object
      expect(controller.state).toBe(s);
    });

    await controller.advance();
  });
});

// ---------------------------------------------------------------------------
// Manifest step
// ---------------------------------------------------------------------------

/**
 * Creates a temporary directory structure suitable for manifest discovery:
 * a `.git` directory (so the walker stops) and a `.makaio/manifest.json`
 * containing the given extension specs.
 * @param repoRoot - Root of the temporary repository.
 * @param extensions - Extension spec strings to write into the manifest.
 */
async function makeRepoWithManifest(repoRoot: string, extensions: string[]): Promise<void> {
  await mkdir(join(repoRoot, '.git'), { recursive: true });
  await mkdir(join(repoRoot, '.makaio'), { recursive: true });
  await writeFile(
    join(repoRoot, '.makaio', 'manifest.json'),
    JSON.stringify({ $schema: 'makaio/project-manifest/v1', extensions }),
    'utf-8',
  );
}

/**
 * Creates a temporary repository with a malformed project manifest.
 * @param repoRoot - Root of the temporary repository.
 */
async function makeRepoWithMalformedManifest(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, '.git'), { recursive: true });
  await mkdir(join(repoRoot, '.makaio'), { recursive: true });
  await writeFile(join(repoRoot, '.makaio', 'manifest.json'), '{ malformed json', 'utf-8');
}

describe('manifest step', () => {
  let mockBus: MockBusResult;
  let dir: string;
  let repoDir: string;

  beforeEach(async () => {
    mockBus = createMockBus();
    mockBus.request.mockImplementation((subject: unknown) => {
      if (subject === PackageSubjects.list) {
        return Promise.resolve({ packages: [] });
      }
      return Promise.resolve({});
    });
    dir = await makeTempDir();
    // repoDir is a separate temp directory acting as the project repo root.
    repoDir = await mkdtemp(join(tmpdir(), 'makaio-setup-repo-test-'));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('transitions to manifest step after consent when manifest has extensions', async () => {
    await makeRepoWithManifest(repoDir, ['@makaio/extension-workflow@0.1.0']);

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      repoPath: repoDir,
    });

    await controller.actions.acceptConsent();

    expect(controller.state.step).toBe('detect');
    expect(controller.state.manifestExtensionSpecs).toEqual(['@makaio/extension-workflow@0.1.0']);
    expect(controller.state.selectedManifestExtensionSpecs).toEqual(['@makaio/extension-workflow@0.1.0']);
  });

  it('advance() from detect routes to manifest when extensions are present', async () => {
    await makeRepoWithManifest(repoDir, ['@makaio/extension-workflow@0.1.0']);
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      repoPath: repoDir,
    });

    expect(controller.state.step).toBe('detect');
    await controller.advance();

    expect(controller.state.step).toBe('manifest');
  });

  it('advance() from detect skips manifest when no extensions are present', async () => {
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    expect(controller.state.step).toBe('detect');
    setupFullInstallResponses(mockBus, '@makaio/client-claude-code');
    await controller.advance();

    expect(controller.state.step).not.toBe('manifest');
  });

  it('starts at detect with manifest specs pre-loaded when consent already accepted', async () => {
    await makeRepoWithManifest(repoDir, ['@makaio/extension-workflow@0.1.0']);
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      repoPath: repoDir,
    });

    expect(controller.state.step).toBe('detect');
    expect(controller.state.manifestExtensionSpecs).toEqual(['@makaio/extension-workflow@0.1.0']);
    expect(controller.state.selectedManifestExtensionSpecs).toEqual(['@makaio/extension-workflow@0.1.0']);
  });

  it('starts setup with an empty manifest state when the project manifest is malformed', async () => {
    await makeRepoWithMalformedManifest(repoDir);
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const controller = await createSetupController({
        bus: mockBus.bus,
        makaioHome: dir,
        repoPath: repoDir,
      });

      expect(controller.state.step).toBe('detect');
      expect(controller.state.manifestExtensionSpecs).toEqual([]);
      expect(controller.state.selectedManifestExtensionSpecs).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Project manifest ignored:'), expect.any(String));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not enter manifest step when all manifest extensions are already installed', async () => {
    await makeRepoWithManifest(repoDir, ['@makaio/extension-workflow@0.1.0']);
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });
    mockBus.request.mockImplementation((subject: unknown) => {
      if (subject === PackageSubjects.list) {
        return Promise.resolve({
          packages: [{ name: '@makaio/extension-workflow', version: '0.1.0', hasDescriptor: true }],
        });
      }
      if (subject === PackageSubjects.install) {
        return Promise.resolve({ success: true, packageName: 'test-package', restartRequired: false });
      }
      if (subject === ClientSubjects.scan || subject === ClientSubjects.list) {
        return Promise.resolve(subject === ClientSubjects.list ? { clients: [] } : { results: [] });
      }
      return Promise.resolve({});
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      repoPath: repoDir,
    });

    expect(controller.state.manifestExtensionSpecs).toEqual([]);
    await controller.advance();
    expect(controller.state.step).toBe('complete');
  });

  it('records manifest version mismatches for the TUI', async () => {
    await makeRepoWithManifest(repoDir, ['@makaio/extension-workflow@0.1.0']);
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });
    mockBus.request.mockImplementation((subject: unknown) => {
      if (subject === PackageSubjects.list) {
        return Promise.resolve({
          packages: [{ name: '@makaio/extension-workflow', version: '0.2.0', hasDescriptor: true }],
        });
      }
      return Promise.resolve({});
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      repoPath: repoDir,
    });

    expect(controller.state.manifestExtensionSpecs).toEqual(['@makaio/extension-workflow@0.1.0']);
    expect(controller.state.manifestExtensionMismatches).toEqual([
      {
        manifest: {
          packageName: '@makaio/extension-workflow',
          version: '0.1.0',
          spec: '@makaio/extension-workflow@0.1.0',
        },
        installedVersion: '0.2.0',
      },
    ]);
  });

  it('setManifestExtensionSelected toggles a spec out of selectedManifestExtensionSpecs', async () => {
    await makeRepoWithManifest(repoDir, ['@makaio/extension-workflow@0.1.0']);
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      repoPath: repoDir,
    });

    // Transition to manifest step
    await controller.advance();
    expect(controller.state.step).toBe('manifest');

    controller.actions.setManifestExtensionSelected('@makaio/extension-workflow@0.1.0', false);
    expect(controller.state.selectedManifestExtensionSpecs).toHaveLength(0);

    controller.actions.setManifestExtensionSelected('@makaio/extension-workflow@0.1.0', true);
    expect(controller.state.selectedManifestExtensionSpecs).toEqual(['@makaio/extension-workflow@0.1.0']);
  });

  it('setManifestExtensionSelected is a no-op outside the manifest step', async () => {
    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
    });

    expect(controller.state.step).toBe('consent');
    const stateBefore = controller.state;
    controller.actions.setManifestExtensionSelected('@makaio/extension-workflow@0.1.0', false);

    expect(controller.state).toBe(stateBefore);
  });

  it('setManifestExtensionSelected rejects specs outside the manifest list', async () => {
    await makeRepoWithManifest(repoDir, ['@makaio/extension-workflow@0.1.0']);
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      repoPath: repoDir,
    });

    await controller.advance();
    expect(controller.state.step).toBe('manifest');
    const stateBefore = controller.state;

    controller.actions.setManifestExtensionSelected('@makaio/extension-unknown@9.9.9', true);

    expect(controller.state).toBe(stateBefore);
    expect(controller.state.selectedManifestExtensionSpecs).toEqual(['@makaio/extension-workflow@0.1.0']);
  });

  it('installs selected manifest pins and lets manifest pins override duplicate client packages', async () => {
    await makeRepoWithManifest(repoDir, ['@makaio/client-codex@0.1.0']);
    const hash = await getRealTermsHash();
    await writeConsentRecord(dir, {
      acceptedAt: new Date().toISOString(),
      documentHash: hash,
      documentVersion: '2026-05-17',
    });
    const installedPackages: string[] = [];
    mockBus.request.mockImplementation((subject: unknown, payload?: unknown) => {
      if (subject === PackageSubjects.list) {
        return Promise.resolve({ packages: [] });
      }
      if (subject === PackageSubjects.install) {
        const names = (payload as { packageNames?: string[] }).packageNames ?? [];
        installedPackages.push(...names);
        return Promise.resolve({
          success: true,
          packageName: names[0] ?? '',
          restartRequired: false,
        });
      }
      if (subject === ClientSubjects.scan || subject === ClientSubjects.list) {
        return Promise.resolve(subject === ClientSubjects.list ? { clients: [] } : { results: [] });
      }
      return Promise.resolve({});
    });

    const controller = await createSetupController({
      bus: mockBus.bus,
      makaioHome: dir,
      repoPath: repoDir,
    });

    controller.actions.setClientSelected('codex', true);
    await controller.advance();
    await controller.advance();

    expect(installedPackages).toContain('@makaio/client-codex@0.1.0');
    expect(installedPackages).not.toContain('@makaio/client-codex');
  });
});

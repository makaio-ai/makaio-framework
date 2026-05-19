/**
 * Shared test fixtures for setup TUI component tests.
 *
 * Provides the EventEmitter shim required for ink v6 / ink-testing-library v3
 * compatibility, plus factory helpers for SetupState and DetectedClient.
 * @packageDocumentation
 */

import { EventEmitter } from 'node:events';
import type { SetupState } from '@makaio/setup';

// ---------------------------------------------------------------------------
// ink v6 / ink-testing-library v3 compatibility shim
// ink 6.x calls stdin.ref() / stdin.unref() for raw-mode lifecycle, but the
// Stdin mock in ink-testing-library 3.x (which extends EventEmitter) does not
// implement those methods. Adding no-op stubs resolves the crash.
// ---------------------------------------------------------------------------
if (!('ref' in EventEmitter.prototype)) {
  Object.defineProperty(EventEmitter.prototype, 'ref', {
    value: function () {},
    writable: true,
    configurable: true,
  });
}
if (!('unref' in EventEmitter.prototype)) {
  Object.defineProperty(EventEmitter.prototype, 'unref', {
    value: function () {},
    writable: true,
    configurable: true,
  });
}

/**
 * Builds a minimal valid SetupState fixture for use in tests.
 * @param overrides - Partial state fields to merge over the defaults.
 * @returns A complete SetupState suitable for component tests.
 */
export function makeState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    step: 'consent',
    mode: 'interactive',
    termsText: 'Terms content here.',
    termsVersion: '1.0',
    termsHash: 'abc123',
    consentAccepted: false,
    detectedClients: [],
    selectedClientIds: [],
    extensionInstallProgress: [],
    restartRequested: false,
    managedBinaryStates: [],
    result: null,
    error: null,
    ...overrides,
  };
}

/**
 * Builds a minimal DetectedClient fixture.
 * @param clientId - Unique client identifier.
 * @param displayName - Human-readable name.
 * @param detected - Whether the client binary was found on the system.
 * @returns A DetectedClient object.
 */
export function makeClient(
  clientId: string,
  displayName: string,
  detected = true,
): SetupState['detectedClients'][number] {
  return {
    entry: {
      clientId,
      displayName,
      binaryName: clientId,
      detectPaths: [],
      extensionPackages: [],
    },
    detected,
  };
}

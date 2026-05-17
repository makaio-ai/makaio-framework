/**
 * Tests for {@link ClientBinaryVersionResolver}.
 *
 * The resolver enforces pin-only semantics: every managed install uses the
 * exact version declared in the descriptor. No network calls or cache state
 * are involved.
 */

import { describe, expect, it } from 'vitest';
import type { ManagedInstallDescriptor } from '@makaio/contracts/client';
import { ClientBinaryVersionResolver } from '../client-binary-version-resolver.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal npm descriptor with a pinned version used across tests. */
const NPM_DESCRIPTOR: ManagedInstallDescriptor = {
  type: 'npm',
  package: '@openai/codex',
  version: '0.130.0',
};

const CLIENT_ID = 'codex';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientBinaryVersionResolver', () => {
  // -------------------------------------------------------------------------
  // No explicit version — returns descriptor pin
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion without explicit version', () => {
    it('resolves install without explicit version to the descriptor pin', () => {
      const resolver = new ClientBinaryVersionResolver();

      const result = resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR);

      expect(result).toEqual({ version: '0.130.0', explicit: false });
    });

    it('returns the pin even when called multiple times on the same resolver instance', () => {
      const resolver = new ClientBinaryVersionResolver();

      const first = resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR);
      const second = resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR);

      expect(first).toEqual(second);
    });
  });

  // -------------------------------------------------------------------------
  // Explicit version that matches the pin
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion with explicit version matching the pin', () => {
    it('accepts explicit version when it equals the descriptor pin', () => {
      const resolver = new ClientBinaryVersionResolver();

      const result = resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR, '0.130.0');

      expect(result).toEqual({ version: '0.130.0', explicit: true });
    });

    it('trims whitespace from an explicit version before comparing', () => {
      const resolver = new ClientBinaryVersionResolver();

      const result = resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR, '  0.130.0  ');

      expect(result).toEqual({ version: '0.130.0', explicit: true });
    });
  });

  // -------------------------------------------------------------------------
  // Explicit version that differs from the pin — rejected
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion with explicit version not matching the pin', () => {
    it('rejects explicit version that differs from the descriptor pin', () => {
      const resolver = new ClientBinaryVersionResolver();

      expect(() => resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR, '0.129.0')).toThrow(
        "client.install: requested version 0.129.0 for client 'codex' does not match pinned version 0.130.0",
      );
    });

    it('includes the clientId in the rejection message', () => {
      const resolver = new ClientBinaryVersionResolver();

      expect(() => resolver.resolveInstallVersion('claude-code', NPM_DESCRIPTOR, '1.0.0')).toThrow(
        "client 'claude-code'",
      );
    });

    it('includes both the requested and pinned versions in the rejection message', () => {
      const resolver = new ClientBinaryVersionResolver();

      expect(() => resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR, '0.0.1')).toThrow(
        'requested version 0.0.1',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Empty / whitespace-only explicit version — rejected
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion with empty explicit version', () => {
    it('throws when the explicit version is an empty string', () => {
      const resolver = new ClientBinaryVersionResolver();

      expect(() => resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR, '')).toThrow(
        'Explicit version returned an empty version string',
      );
    });

    it('throws when the explicit version is a whitespace-only string', () => {
      const resolver = new ClientBinaryVersionResolver();

      expect(() => resolver.resolveInstallVersion(CLIENT_ID, NPM_DESCRIPTOR, '   ')).toThrow(
        'Explicit version returned an empty version string',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Works with different descriptor types
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion with signed-binary-bucket descriptor', () => {
    it('returns the pinned version from a signed-binary-bucket descriptor', () => {
      const resolver = new ClientBinaryVersionResolver();
      const descriptor: ManagedInstallDescriptor = {
        type: 'signed-binary-bucket',
        version: '2.1.143',
        config: {
          baseUrl: 'https://downloads.example.com/releases',
          manifestPathTemplate: '{version}/manifest.json',
          manifestSignaturePathTemplate: '{version}/manifest.json.sig',
          publicKeyUrl: 'https://downloads.example.com/keys/release.asc',
          publicKeyFingerprint: 'ABCD 1234',
          binaryPathTemplate: '{version}/{platform}/{binary}',
          platforms: { 'darwin-arm64': 'darwin-arm64' },
        },
      };

      const result = resolver.resolveInstallVersion('test-client', descriptor);

      expect(result).toEqual({ version: '2.1.143', explicit: false });
    });
  });
});

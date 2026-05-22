/**
 * Tests for the {@link createStrategy} factory function.
 *
 * Verifies that the factory returns the correct {@link InstallStrategy}
 * subclass for each supported managed install descriptor discriminant, returns
 * `undefined` for an unknown descriptor type at runtime, and rejects the
 * previously-supported (now-removed) `manifest-bucket` and `github-release`
 * descriptor types.
 *
 * Coverage (RT-13 / TG-8):
 * - Returns {@link NpmStrategy} for `npm`
 * - Returns {@link SignedBinaryBucketStrategy} for `signed-binary-bucket`
 * - Returns `undefined` for an unknown descriptor type at runtime
 * - Returns `undefined` for removed `manifest-bucket` and `github-release` types
 */

import { describe, expect, it, vi } from 'vitest';
import type { NpmInstallDescriptor } from '@makaio/contracts/client';
import { createStrategy, NpmStrategy, SignedBinaryBucketStrategy } from '../index.js';
import type { StrategyDependencies } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal npm descriptor — includes the required exact version pin. */
const NPM_DESCRIPTOR: NpmInstallDescriptor = {
  type: 'npm',
  package: '@example/my-cli',
  version: '1.2.3',
};

/**
 * Minimal {@link StrategyDependencies} stub — all methods throw if called.
 *
 * The factory tests only verify instance type; no I/O is executed.
 * @returns A stub with all required dependency methods replaced by throwing fns.
 */
function makeDeps(): StrategyDependencies {
  const notCalled = (name: string) => (): never => {
    throw new Error(`StrategyDependencies.${name} must not be called in factory tests`);
  };
  return {
    fetchText: vi.fn(notCalled('fetchText')),
    fetchJson: vi.fn(notCalled('fetchJson')),
    downloadFile: vi.fn(notCalled('downloadFile')),
    exec: vi.fn(notCalled('exec')),
    extractArchive: vi.fn(notCalled('extractArchive')),
    deleteFile: vi.fn(notCalled('deleteFile')),
    computeChecksum: vi.fn(notCalled('computeChecksum')),
    removeDirectory: vi.fn(notCalled('removeDirectory')),
  };
}

// ---------------------------------------------------------------------------
// createStrategy factory
// ---------------------------------------------------------------------------

describe('createStrategy', () => {
  it('returns an NpmStrategy for an npm descriptor', () => {
    const strategy = createStrategy(NPM_DESCRIPTOR, makeDeps());

    expect(strategy).toBeInstanceOf(NpmStrategy);
  });

  it('returns a SignedBinaryBucketStrategy for a signed-binary-bucket descriptor', () => {
    const descriptor = {
      type: 'signed-binary-bucket',
      version: '2.1.143',
      config: {
        baseUrl: 'https://downloads.example.com/releases',
        manifestPathTemplate: '{version}/manifest.json',
        manifestSignaturePathTemplate: '{version}/manifest.json.sig',
        publicKeyUrl: 'https://downloads.example.com/keys/signing.asc',
        publicKeyFingerprint: 'ABCD EF01 2345 6789 ABCD EF01 2345 6789 ABCD EF01',
        binaryPathTemplate: '{version}/{platform}/{binary}',
        platforms: { 'darwin-arm64': 'darwin-arm64' },
      },
    };

    expect(createStrategy(descriptor, makeDeps())).toBeInstanceOf(SignedBinaryBucketStrategy);
  });

  it('returns undefined for an unknown descriptor type at runtime', () => {
    // Runtime callers may pass unvalidated descriptor-like values; the factory
    // validates before narrowing so unsupported descriptor types fail closed.
    const unknownDescriptor = { type: 'unknown-type' };

    expect(createStrategy(unknownDescriptor, makeDeps())).toBeUndefined();
  });

  it('rejects removed manifest-bucket and github-release descriptors', () => {
    // These types were removed from ManagedInstallDescriptorSchema in Task 1.
    // The factory must return undefined, not throw.
    expect(createStrategy({ type: 'manifest-bucket' }, makeDeps())).toBeUndefined();
    expect(createStrategy({ type: 'github-release' }, makeDeps())).toBeUndefined();
  });
});

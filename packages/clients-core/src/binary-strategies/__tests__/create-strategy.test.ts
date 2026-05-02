/**
 * Tests for the {@link createStrategy} factory function.
 *
 * Verifies that the factory returns the correct {@link InstallStrategy}
 * subclass for each supported managed install descriptor discriminant
 * and returns `undefined` for an unknown descriptor type at runtime.
 *
 * Coverage (RT-13 / TG-8):
 * - Returns {@link ManifestBucketStrategy} for `manifest-bucket`
 * - Returns {@link NpmStrategy} for `npm`
 * - Returns {@link GithubReleaseStrategy} for `github-release`
 * - Returns `undefined` for an unknown descriptor type at runtime
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  GithubReleaseInstallDescriptor,
  ManifestBucketInstallDescriptor,
  NpmInstallDescriptor,
} from '@makaio/contracts/client';
import { createStrategy, GithubReleaseStrategy, ManifestBucketStrategy, NpmStrategy } from '../index.js';
import type { StrategyDependencies } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal manifest-bucket descriptor. */
const MANIFEST_BUCKET_DESCRIPTOR: ManifestBucketInstallDescriptor = {
  type: 'manifest-bucket',
  config: {
    baseUrl: 'https://storage.example.com/client',
    versionIndex: { latest: 'latest.txt' },
    manifestPath: 'manifest.json',
    manifestChecksumField: 'sha256',
    binaryPath: 'bin/client',
  },
};

/** Minimal npm descriptor. */
const NPM_DESCRIPTOR: NpmInstallDescriptor = {
  type: 'npm',
  package: '@example/my-cli',
};

/** Minimal github-release descriptor using the actual runtime platform key. */
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const GITHUB_RELEASE_DESCRIPTOR: GithubReleaseInstallDescriptor = {
  type: 'github-release',
  repo: 'example-org/my-tool',
  assetPattern: { [PLATFORM_KEY]: `my-tool-${PLATFORM_KEY}.tar.gz` },
  archiveFormat: 'tar.gz',
};

/**
 * Minimal {@link StrategyDependencies} stub — all methods throw if called.
 *
 * The factory tests only verify instance type; no I/O is executed.
 */
function makeStubDeps(): StrategyDependencies {
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
  it('returns a ManifestBucketStrategy for a manifest-bucket descriptor', () => {
    const strategy = createStrategy(MANIFEST_BUCKET_DESCRIPTOR, makeStubDeps());

    expect(strategy).toBeInstanceOf(ManifestBucketStrategy);
  });

  it('returns an NpmStrategy for an npm descriptor', () => {
    const strategy = createStrategy(NPM_DESCRIPTOR, makeStubDeps());

    expect(strategy).toBeInstanceOf(NpmStrategy);
  });

  it('returns a GithubReleaseStrategy for a github-release descriptor', () => {
    const strategy = createStrategy(GITHUB_RELEASE_DESCRIPTOR, makeStubDeps());

    expect(strategy).toBeInstanceOf(GithubReleaseStrategy);
  });

  it('returns undefined for an unknown descriptor type at runtime', () => {
    // Runtime callers may pass unvalidated descriptor-like values; the factory
    // validates before narrowing so unsupported descriptor types fail closed.
    const unknownDescriptor = { type: 'unknown-type' };

    expect(createStrategy(unknownDescriptor, makeStubDeps())).toBeUndefined();
  });
});

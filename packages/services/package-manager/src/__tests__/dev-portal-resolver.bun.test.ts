/**
 * DevPortalPackageManager Tests
 *
 * Verifies that the dev-mode portal resolver rewrites install specs for known
 * workspace packages to `portal:` ranges and delegates all other method calls
 * to the inner package manager unchanged.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import type { ExtensionDescriptor } from '@makaio/contracts';
import type { DependencyPackageManager } from '../dependency-resolver.js';
import type { InstalledExtensionDescriptor } from '../yarn-integration.js';
import { DevPortalPackageManager, type DevPortalMap } from '../dev-portal-resolver.js';

// ---------------------------------------------------------------------------
// Fake inner package manager
// ---------------------------------------------------------------------------

/**
 * Minimal fake {@link DependencyPackageManager} that records calls and returns
 * configurable results. Does not invoke Yarn.
 */
class FakeInner implements DependencyPackageManager {
  /** Specs forwarded to {@link installPackage}, in order. */
  public readonly installCalls: string[] = [];

  /**
   * @param version - Version string returned by {@link installPackage}.
   */
  public constructor(private readonly version = '1.0.0') {}

  /**
   * Records the spec and returns the configured version.
   * @param packageSpec - Yarn-compatible package specifier.
   * @returns Configured version string.
   */
  public async installPackage(packageSpec: string): Promise<string> {
    this.installCalls.push(packageSpec);
    return this.version;
  }

  public async readInstalledExtensionDescriptor(_npmName: string): Promise<ExtensionDescriptor | null> {
    return null;
  }

  public async listInstalledExtensionDescriptors(): Promise<InstalledExtensionDescriptor[]> {
    return [];
  }

  public async readManifestSnapshot(): Promise<unknown> {
    return {};
  }

  public async writeManifestAndReinstall(_snapshot: unknown): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a {@link DevPortalMap} from a plain record for test readability.
 * @param entries - Record of npm name → workspace directory path.
 * @returns Immutable map.
 */
function portalMap(entries: Record<string, string>): DevPortalMap {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DevPortalPackageManager', () => {
  describe('installPackage', () => {
    it('rewrites a bare npm name that matches the portal map', async () => {
      const inner = new FakeInner();
      const sut = new DevPortalPackageManager(
        inner,
        portalMap({ '@makaio/client-claude-code': '/workspace/extensions/client-claude-code' }),
      );

      await sut.installPackage('@makaio/client-claude-code');

      expect(inner.installCalls).toHaveLength(1);
      expect(inner.installCalls[0]).toBe('@makaio/client-claude-code@portal:/workspace/extensions/client-claude-code');
    });

    it('rewrites a spec with explicit range when the npm name matches', async () => {
      const inner = new FakeInner();
      const sut = new DevPortalPackageManager(
        inner,
        portalMap({ '@makaio/client-claude-code': '/workspace/extensions/client-claude-code' }),
      );

      await sut.installPackage('@makaio/client-claude-code@^1.0.0');

      expect(inner.installCalls).toHaveLength(1);
      // Range is discarded and replaced by portal:
      expect(inner.installCalls[0]).toBe('@makaio/client-claude-code@portal:/workspace/extensions/client-claude-code');
    });

    it('passes an unmatched spec through unchanged', async () => {
      const inner = new FakeInner();
      const sut = new DevPortalPackageManager(
        inner,
        portalMap({ '@makaio/client-claude-code': '/workspace/extensions/client-claude-code' }),
      );

      await sut.installPackage('@makaio/other-extension@^2.0.0');

      expect(inner.installCalls).toHaveLength(1);
      expect(inner.installCalls[0]).toBe('@makaio/other-extension@^2.0.0');
    });

    it('correctly extracts scoped package name with range for lookup', async () => {
      const inner = new FakeInner();
      const sut = new DevPortalPackageManager(
        inner,
        portalMap({ '@makaio/client-claude-code': '/workspace/extensions/client-claude-code' }),
      );

      // Spec includes a range — only the scoped name up to the second @ is the key
      await sut.installPackage('@makaio/client-claude-code@>=0.5.0');

      expect(inner.installCalls[0]).toMatch(/^@makaio\/client-claude-code@portal:/);
    });

    it('rewrites an unscoped package name that matches the portal map', async () => {
      const inner = new FakeInner();
      const sut = new DevPortalPackageManager(inner, portalMap({ 'my-plugin': '/workspace/plugins/my-plugin' }));

      await sut.installPackage('my-plugin@^3.0.0');

      expect(inner.installCalls).toHaveLength(1);
      expect(inner.installCalls[0]).toBe('my-plugin@portal:/workspace/plugins/my-plugin');
    });

    it('passes an unscoped unmatched spec through unchanged', async () => {
      const inner = new FakeInner();
      const sut = new DevPortalPackageManager(inner, portalMap({ 'my-plugin': '/ws/plugins/p' }));

      await sut.installPackage('other-plugin@^1.0.0');

      expect(inner.installCalls[0]).toBe('other-plugin@^1.0.0');
    });

    it('returns the version resolved by the inner package manager', async () => {
      const inner = new FakeInner('2.3.4');
      const sut = new DevPortalPackageManager(inner, portalMap({ '@makaio/client-claude-code': '/workspace/ext' }));

      const version = await sut.installPackage('@makaio/client-claude-code');

      expect(version).toBe('2.3.4');
    });
  });

  describe('delegated methods', () => {
    it('delegates readInstalledExtensionDescriptor to inner', async () => {
      const inner = new FakeInner();
      const spy = spyOn(inner, 'readInstalledExtensionDescriptor');
      const sut = new DevPortalPackageManager(inner, new Map());

      await sut.readInstalledExtensionDescriptor('@makaio/some-pkg');

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith('@makaio/some-pkg');
    });

    it('delegates listInstalledExtensionDescriptors to inner', async () => {
      const inner = new FakeInner();
      const spy = spyOn(inner, 'listInstalledExtensionDescriptors');
      const sut = new DevPortalPackageManager(inner, new Map());

      await sut.listInstalledExtensionDescriptors();

      expect(spy).toHaveBeenCalledOnce();
    });

    it('delegates readManifestSnapshot to inner', async () => {
      const inner = new FakeInner();
      const spy = spyOn(inner, 'readManifestSnapshot');
      const sut = new DevPortalPackageManager(inner, new Map());

      await sut.readManifestSnapshot();

      expect(spy).toHaveBeenCalledOnce();
    });

    it('delegates writeManifestAndReinstall to inner', async () => {
      const inner = new FakeInner();
      const spy = spyOn(inner, 'writeManifestAndReinstall');
      const sut = new DevPortalPackageManager(inner, new Map());
      const snapshot = { deps: {} };

      await sut.writeManifestAndReinstall(snapshot);

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(snapshot);
    });
  });
});

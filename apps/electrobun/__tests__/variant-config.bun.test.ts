import { describe, expect, it } from 'bun:test';
import {
  resolveVariantConfig,
  resolveVariantReleaseChannel,
  resolveVariantRendererConfig,
} from '../src/variant-config.js';

describe('resolveVariantConfig', () => {
  it('defaults to base variant (no CEF)', () => {
    const config = resolveVariantConfig(undefined);
    expect(config.bundleCEF).toBe(false);
    expect(config.defaultRenderer).toBe('native');
    expect(config.releaseTrack).toBe('stable');
    expect(config.electrobunBuildEnv).toBe('stable');
    expect(config.variant).toBe('base');
  });

  it('defaults to base variant when MAKAIO_VARIANT is empty', () => {
    const config = resolveVariantConfig('');
    expect(config.bundleCEF).toBe(false);
    expect(config.defaultRenderer).toBe('native');
    expect(config.releaseTrack).toBe('stable');
    expect(config.electrobunBuildEnv).toBe('stable');
    expect(config.variant).toBe('base');
  });

  it('respects MAKAIO_VARIANT=cef', () => {
    const config = resolveVariantConfig('cef');
    expect(config.bundleCEF).toBe(true);
    expect(config.defaultRenderer).toBe('cef');
    expect(config.releaseTrack).toBe('stable');
    expect(config.electrobunBuildEnv).toBe('stable');
    expect(config.variant).toBe('cef');
  });

  it('respects MAKAIO_VARIANT=base explicitly', () => {
    const config = resolveVariantConfig('base');
    expect(config.bundleCEF).toBe(false);
    expect(config.defaultRenderer).toBe('native');
    expect(config.releaseTrack).toBe('stable');
    expect(config.electrobunBuildEnv).toBe('stable');
    expect(config.variant).toBe('base');
  });

  it('maps canary release track to canary build env', () => {
    const config = resolveVariantConfig('base', 'canary');
    expect(config.bundleCEF).toBe(false);
    expect(config.defaultRenderer).toBe('native');
    expect(config.releaseTrack).toBe('canary');
    expect(config.electrobunBuildEnv).toBe('canary');
    expect(config.variant).toBe('base');
  });

  it('maps CEF canary to canary build env with CEF renderer', () => {
    const config = resolveVariantConfig('cef', 'canary');
    expect(config.bundleCEF).toBe(true);
    expect(config.defaultRenderer).toBe('cef');
    expect(config.releaseTrack).toBe('canary');
    expect(config.electrobunBuildEnv).toBe('canary');
    expect(config.variant).toBe('cef');
  });

  it('separates variants via buildFolder and artifactFolder', () => {
    const base = resolveVariantConfig('base', 'stable');
    const cef = resolveVariantConfig('cef', 'stable');
    expect(base.buildFolder).toBe('build/base-stable');
    expect(base.artifactFolder).toBe('artifacts/base-stable');
    expect(cef.buildFolder).toBe('build/cef-stable');
    expect(cef.artifactFolder).toBe('artifacts/cef-stable');
  });

  it('separates canary variants via folders', () => {
    const base = resolveVariantConfig('base', 'canary');
    const cef = resolveVariantConfig('cef', 'canary');
    expect(base.buildFolder).toBe('build/base-canary');
    expect(base.artifactFolder).toBe('artifacts/base-canary');
    expect(cef.buildFolder).toBe('build/cef-canary');
    expect(cef.artifactFolder).toBe('artifacts/cef-canary');
  });

  it('throws on unknown variant', () => {
    expect(() => resolveVariantConfig('invalid')).toThrow('Unknown variant');
  });

  it('rejects inherited object keys as variant names', () => {
    expect(() => resolveVariantConfig('toString')).toThrow('Unknown variant');
  });

  it('throws on unknown release track', () => {
    expect(() => resolveVariantConfig('base', 'nightly')).toThrow('Unknown release track');
  });

  it('rejects inherited object keys as release tracks', () => {
    expect(() => resolveVariantConfig('base', 'toString')).toThrow('Unknown release track');
  });

  it('produces the full config shape for base variant', () => {
    expect(resolveVariantConfig('base')).toEqual({
      variant: 'base',
      releaseTrack: 'stable',
      electrobunBuildEnv: 'stable',
      bundleCEF: false,
      defaultRenderer: 'native',
      buildFolder: 'build/base-stable',
      artifactFolder: 'artifacts/base-stable',
    });
  });

  it('produces the full config shape for cef variant', () => {
    expect(resolveVariantConfig('cef')).toEqual({
      variant: 'cef',
      releaseTrack: 'stable',
      electrobunBuildEnv: 'stable',
      bundleCEF: true,
      defaultRenderer: 'cef',
      buildFolder: 'build/cef-stable',
      artifactFolder: 'artifacts/cef-stable',
    });
  });
});

describe('resolveVariantReleaseChannel', () => {
  it('maps base/stable to the stable release channel', () => {
    expect(resolveVariantReleaseChannel('base')).toBe('stable');
  });

  it('maps cef/stable to the cef release channel', () => {
    expect(resolveVariantReleaseChannel('cef')).toBe('cef');
  });

  it('maps canary variants to canary-specific release channels', () => {
    expect(resolveVariantReleaseChannel('base', 'canary')).toBe('canary');
    expect(resolveVariantReleaseChannel('cef', 'canary')).toBe('cef-canary');
  });
});

describe('resolveVariantRendererConfig', () => {
  it('maps the base variant to the native renderer backend', () => {
    expect(resolveVariantRendererConfig(resolveVariantConfig('base'))).toEqual({
      bundleCEF: false,
      defaultRenderer: 'native',
    });
  });

  it('maps the cef variant to the CEF renderer backend', () => {
    expect(resolveVariantRendererConfig(resolveVariantConfig('cef'))).toEqual({
      bundleCEF: true,
      defaultRenderer: 'cef',
    });
  });
});

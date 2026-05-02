import { describe, expect, it } from 'vitest';
import {
  resolveVariantConfig,
  resolveVariantRendererConfig,
  resolveVariantUpdateChannel,
} from '../src/variant-config.js';

describe('resolveVariantConfig', () => {
  it('defaults to base variant (no CEF)', () => {
    const config = resolveVariantConfig(undefined);
    expect(config.bundleCEF).toBe(false);
    expect(config.defaultRenderer).toBe('native');
    expect(config.releaseTrack).toBe('stable');
    expect(config.updateChannel).toBe('stable');
    expect(config.variant).toBe('base');
  });

  it('defaults to base variant when MAKAIO_VARIANT is empty', () => {
    const config = resolveVariantConfig('');
    expect(config.bundleCEF).toBe(false);
    expect(config.defaultRenderer).toBe('native');
    expect(config.releaseTrack).toBe('stable');
    expect(config.updateChannel).toBe('stable');
    expect(config.variant).toBe('base');
  });

  it('respects MAKAIO_VARIANT=cef', () => {
    const config = resolveVariantConfig('cef');
    expect(config.bundleCEF).toBe(true);
    expect(config.defaultRenderer).toBe('cef');
    expect(config.releaseTrack).toBe('stable');
    expect(config.updateChannel).toBe('cef');
    expect(config.variant).toBe('cef');
  });

  it('respects MAKAIO_VARIANT=base explicitly', () => {
    const config = resolveVariantConfig('base');
    expect(config.bundleCEF).toBe(false);
    expect(config.defaultRenderer).toBe('native');
    expect(config.releaseTrack).toBe('stable');
    expect(config.updateChannel).toBe('stable');
    expect(config.variant).toBe('base');
  });

  it('maps base canary builds to the canary channel', () => {
    const config = resolveVariantConfig('base', 'canary');
    expect(config.bundleCEF).toBe(false);
    expect(config.defaultRenderer).toBe('native');
    expect(config.releaseTrack).toBe('canary');
    expect(config.updateChannel).toBe('canary');
    expect(config.variant).toBe('base');
  });

  it('maps CEF canary builds to the cef-canary channel', () => {
    const config = resolveVariantConfig('cef', 'canary');
    expect(config.bundleCEF).toBe(true);
    expect(config.defaultRenderer).toBe('cef');
    expect(config.releaseTrack).toBe('canary');
    expect(config.updateChannel).toBe('cef-canary');
    expect(config.variant).toBe('cef');
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

  it('produces serializable metadata for base variant', () => {
    expect(resolveVariantConfig('base')).toEqual({
      variant: 'base',
      releaseTrack: 'stable',
      updateChannel: 'stable',
      bundleCEF: false,
      defaultRenderer: 'native',
    });
  });

  it('produces serializable metadata for cef variant', () => {
    expect(resolveVariantConfig('cef')).toEqual({
      variant: 'cef',
      releaseTrack: 'stable',
      updateChannel: 'cef',
      bundleCEF: true,
      defaultRenderer: 'cef',
    });
  });
});

describe('resolveVariantUpdateChannel', () => {
  it('maps the base host variant to Electrobun stable channel', () => {
    expect(resolveVariantUpdateChannel('base')).toBe('stable');
  });

  it('maps the cef host variant to the cef update channel', () => {
    expect(resolveVariantUpdateChannel('cef')).toBe('cef');
  });

  it('maps canary variants to canary-specific update channels', () => {
    expect(resolveVariantUpdateChannel('base', 'canary')).toBe('canary');
    expect(resolveVariantUpdateChannel('cef', 'canary')).toBe('cef-canary');
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

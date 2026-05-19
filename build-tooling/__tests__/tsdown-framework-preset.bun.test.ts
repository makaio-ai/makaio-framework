import type { Plugin, PluginContext } from 'rolldown';
import { describe, expect, it } from 'bun:test';
import {
  frameworkBusPreset,
  frameworkPreset,
  frameworkReactPreset,
  MAKAIO_BUNDLE_PATTERN,
  packageManifestSourcePolicy,
  VITEST_BUNDLE_PATTERN,
} from '../tsdown-framework-preset.js';

describe('framework tsdown presets', () => {
  it('keeps package manifests as authored source-of-truth metadata', () => {
    expect(packageManifestSourcePolicy.exports).toBe(false);
    expect(packageManifestSourcePolicy.checks.pluginTimings).toBe(false);
    expect(frameworkPreset.exports).toBe(false);
    expect(frameworkReactPreset.exports).toBe(false);
    expect(frameworkBusPreset.exports).toBe(false);
  });

  it('bundles all @makaio/* workspace dependencies via alwaysBundle pattern', () => {
    expect(frameworkPreset.deps.alwaysBundle).toContain(MAKAIO_BUNDLE_PATTERN);
    expect(frameworkPreset.deps.onlyBundle).toBe(false);
    expect(frameworkBusPreset.deps.onlyBundle).toBe(false);
    // The pattern catches all @makaio/* packages; framework-owned ones are
    // externalized first by the frameworkExternals resolveId hook before the
    // bundler evaluates alwaysBundle.
    expect(MAKAIO_BUNDLE_PATTERN.test('@makaio/core')).toBe(true);
    expect(MAKAIO_BUNDLE_PATTERN.test('@makaio/bus-core')).toBe(true);
  });

  it('keeps build diagnostics focused on correctness signals', () => {
    expect(frameworkPreset.checks?.pluginTimings).toBe(false);
    expect(frameworkReactPreset.checks?.pluginTimings).toBe(false);
    expect(frameworkBusPreset.checks?.pluginTimings).toBe(false);
  });

  it('keeps the test runner external for testing helper entries', () => {
    expect(frameworkPreset.deps.neverBundle).toContain('vitest');
    expect(frameworkPreset.deps.neverBundle).toContain(VITEST_BUNDLE_PATTERN);
    expect(VITEST_BUNDLE_PATTERN.test('@vitest/expect')).toBe(true);
  });

  it('externalizes all framework-owned packages through the framework self-reference', () => {
    const plugins = frameworkPreset.plugins as Plugin[];
    const plugin = plugins.find((candidate) => 'name' in candidate && candidate.name === 'framework-externals');
    expect(plugin).toBeDefined();
    if (!plugin) {
      throw new Error('frameworkPreset must register framework-externals');
    }

    expect(plugin.name).toBe('framework-externals');
    expect(plugin.resolveId).toBeTypeOf('function');
    if (typeof plugin.resolveId !== 'function') {
      throw new Error('frameworkExternals must provide a resolveId hook');
    }

    const pluginContext = {} as PluginContext;
    const resolveOptions = { custom: {}, isEntry: false, kind: 'import-statement' } as const;

    // bus-core → @makaio/framework/bus
    expect(plugin.resolveId.call(pluginContext, '@makaio/bus-core', undefined, resolveOptions)).toEqual({
      id: '@makaio/framework/bus',
      external: true,
    });
    // @makaio/core → @makaio/framework/core
    expect(plugin.resolveId.call(pluginContext, '@makaio/core', undefined, resolveOptions)).toEqual({
      id: '@makaio/framework/core',
      external: true,
    });
    // @makaio/contracts → @makaio/framework/contracts
    expect(plugin.resolveId.call(pluginContext, '@makaio/contracts', undefined, resolveOptions)).toEqual({
      id: '@makaio/framework/contracts',
      external: true,
    });
    // non-framework package → not handled
    expect(plugin.resolveId.call(pluginContext, 'zod', undefined, resolveOptions)).toBeNull();
  });
});

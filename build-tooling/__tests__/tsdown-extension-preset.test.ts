import type { ImportKind, Plugin, ResolveIdExtraOptions, ResolveIdResult } from 'rolldown';
import { describe, expect, it } from 'vitest';
import { SHARED_BROWSER_EXTERNALS } from '../browser-shared-externals.js';
import { MAKAIO_BUNDLE_PATTERN } from '../tsdown-framework-preset.js';
import { defineExtensionConfig, extensionPreset } from '../tsdown-extension-preset.js';

/**
 * Extracts the `extension-externals` plugin from a `defineExtensionConfig`
 * result by name.
 * @param nativeModules - Forwarded to {@link defineExtensionConfig}.
 * @param external - Forwarded to {@link defineExtensionConfig}.
 * @returns The rolldown plugin instance.
 */
function getExternalsPlugin(nativeModules?: string[], external?: (string | RegExp)[]): Plugin {
  const config = defineExtensionConfig({ nativeModules, external });
  const resolved = Array.isArray(config) ? config[0] : config;
  const plugins = (resolved as { plugins?: Plugin[] }).plugins ?? [];
  const plugin = plugins.find(
    (p): p is Plugin => typeof p === 'object' && p !== null && 'name' in p && p.name === 'extension-externals',
  );
  if (!plugin) throw new Error('extension-externals plugin not found in config');
  return plugin;
}

/** Minimal valid extra options — the plugin under test ignores all fields. */
const EXTRA_OPTIONS: ResolveIdExtraOptions = {
  isEntry: false,
  kind: 'import-statement' as ImportKind,
};

/**
 * Extracts the `resolveId` handler function from a plugin, handling both the
 * plain-function and `{ handler: fn }` forms of rolldown's `ObjectHook`.
 * @param plugin - The rolldown plugin under test.
 * @returns The bare handler function.
 */
function getResolveIdHandler(plugin: Plugin): (source: string) => ResolveIdResult | Promise<ResolveIdResult> {
  const hook = plugin.resolveId;
  if (!hook) throw new Error('plugin has no resolveId hook');
  // ObjectHook can be the function directly or { handler: fn }
  const fn = typeof hook === 'function' ? hook : hook.handler;
  // The implementation only uses `source`, so the bound `this` is not needed.
  return (source: string) => fn.call(null as never, source, undefined, EXTRA_OPTIONS);
}

describe('extensionExternals plugin', () => {
  it('externalizes every canonical shared browser dependency', () => {
    const resolve = getResolveIdHandler(getExternalsPlugin());
    for (const specifier of SHARED_BROWSER_EXTERNALS) {
      expect(resolve(specifier)).toEqual({ id: specifier, external: true });
    }
  });

  describe('bus-core externalization', () => {
    it('externalizes @makaio/bus-core (exact match)', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin());
      expect(resolve('@makaio/bus-core')).toEqual({ id: '@makaio/bus-core', external: true });
    });

    it('externalizes @makaio/bus-core subpath imports via prefix check', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin());
      expect(resolve('@makaio/bus-core/types')).toEqual({
        id: '@makaio/bus-core/types',
        external: true,
      });
    });

    it('externalizes deep @makaio/bus-core subpath imports', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin());
      expect(resolve('@makaio/bus-core/internal/registry')).toEqual({
        id: '@makaio/bus-core/internal/registry',
        external: true,
      });
    });
  });

  describe('native module externalization', () => {
    it('externalizes a declared native module (exact Set match)', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin(['@napi-rs/keyring']));
      expect(resolve('@napi-rs/keyring')).toEqual({
        id: '@napi-rs/keyring',
        external: true,
      });
    });

    it('does not externalize an undeclared package from the same napi scope', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin(['@napi-rs/keyring']));
      expect(resolve('@napi-rs/other-addon')).toBeNull();
    });

    it('externalizes multiple declared native modules independently', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin(['@napi-rs/keyring', 'better-sqlite3-native']));
      expect(resolve('better-sqlite3-native')).toEqual({
        id: 'better-sqlite3-native',
        external: true,
      });
    });
  });

  describe('extra string pattern externalization', () => {
    it('externalizes an exact-match string from the extra list', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin([], ['heavy-dep']));
      expect(resolve('heavy-dep')).toEqual({ id: 'heavy-dep', external: true });
    });

    it('does not externalize a specifier that merely starts with the extra string', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin([], ['heavy-dep']));
      expect(resolve('heavy-dep/sub')).toBeNull();
    });
  });

  describe('extra regex pattern externalization', () => {
    it('externalizes a specifier matched by a regex in the extra list', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin([], [/^lodash/]));
      expect(resolve('lodash')).toEqual({ id: 'lodash', external: true });
    });

    it('externalizes scoped specifiers matched by a regex', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin([], [/^@scope\//]));
      expect(resolve('@scope/pkg')).toEqual({ id: '@scope/pkg', external: true });
    });

    it('does not externalize a specifier that does not match the regex', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin([], [/^lodash/]));
      expect(resolve('underscore')).toBeNull();
    });

    it('resets lastIndex on a /g regex so successive calls are always deterministic', () => {
      // Without lastIndex reset, a /g regex alternates true/false across calls.
      const stickyRegex = /^lodash/g;
      const resolve = getResolveIdHandler(getExternalsPlugin([], [stickyRegex]));

      for (let i = 0; i < 4; i++) {
        expect(resolve('lodash')).toEqual({ id: 'lodash', external: true });
      }
    });
  });

  describe('non-externalized packages', () => {
    it('returns null for other @makaio/* packages (bundled via alwaysBundle)', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin());
      expect(resolve('@makaio/core')).toBeNull();
    });

    it('returns null for @makaio/framework subpath imports', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin());
      expect(resolve('@makaio/framework/bus')).toBeNull();
    });

    it('returns null for unrelated third-party packages', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin());
      expect(resolve('zod')).toBeNull();
    });

    it('returns null for relative imports', () => {
      const resolve = getResolveIdHandler(getExternalsPlugin());
      expect(resolve('./local-module')).toBeNull();
    });
  });
});

describe('extensionPreset', () => {
  it('uses ESM format', () => {
    expect(extensionPreset.format).toBe('esm');
  });

  it('disables dts output', () => {
    expect(extensionPreset.dts).toBe(false);
  });

  it('enables minification', () => {
    expect(extensionPreset.minify).toBe(true);
  });

  it('does not let tsdown rewrite package manifests', () => {
    expect(extensionPreset.exports).toBe(false);
  });

  it('uses MAKAIO_BUNDLE_PATTERN for alwaysBundle', () => {
    expect(extensionPreset.deps.alwaysBundle).toContain(MAKAIO_BUNDLE_PATTERN);
    expect(extensionPreset.deps.onlyBundle).toBe(false);
  });

  it('keeps build diagnostics focused on correctness signals', () => {
    expect(extensionPreset.checks?.pluginTimings).toBe(false);
  });

  it('includes the extension-externals plugin', () => {
    const plugins = extensionPreset.plugins as Plugin[];
    const plugin = plugins.find((p) => 'name' in p && p.name === 'extension-externals');
    expect(plugin).toBeDefined();
  });
});

describe('defineExtensionConfig', () => {
  it('defaults entry to ./src/index.ts', () => {
    const config = defineExtensionConfig();
    const resolved = Array.isArray(config) ? config[0] : config;
    expect((resolved as { entry?: unknown }).entry).toEqual(['./src/index.ts']);
  });

  it('accepts a custom entry point string', () => {
    const config = defineExtensionConfig({ entry: './src/cli.ts' });
    const resolved = Array.isArray(config) ? config[0] : config;
    expect((resolved as { entry?: unknown }).entry).toBe('./src/cli.ts');
  });

  it('overrides the extensions array so the externals plugin uses the provided options', () => {
    const config = defineExtensionConfig({ nativeModules: ['my-native'] });
    const resolved = Array.isArray(config) ? config[0] : config;
    const plugins = (resolved as { plugins?: Plugin[] }).plugins ?? [];
    const externals = plugins.find(
      (p): p is Plugin => typeof p === 'object' && 'name' in p && p.name === 'extension-externals',
    );
    if (!externals) throw new Error('extension-externals plugin not found');
    const resolve = getResolveIdHandler(externals);
    expect(resolve('my-native')).toEqual({ id: 'my-native', external: true });
  });
});

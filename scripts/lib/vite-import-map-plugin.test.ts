import { describe, expect, it, vi } from 'vitest';
import { SHARED_BROWSER_EXTERNALS } from '../../build-tooling/browser-shared-externals.js';
import type { OutputBundleLike } from './generate-import-map.js';
import { viteImportMapPlugin } from './vite-import-map-plugin.js';

/**
 * Build a minimal bundle for testing - only chunks with facadeModuleId.
 * @param chunks - Array of chunk descriptors to include in the bundle.
 * @returns An OutputBundleLike keyed by chunk fileName.
 */
function makeBundle(chunks: ReadonlyArray<{ fileName: string; facadeModuleId: string | null }>): OutputBundleLike {
  const bundle: OutputBundleLike = {};
  for (const chunk of chunks) {
    bundle[chunk.fileName] = {
      type: 'chunk',
      fileName: chunk.fileName,
      facadeModuleId: chunk.facadeModuleId,
    };
  }
  return bundle;
}

/**
 * Extract and invoke the `generateBundle` hook from a plugin.
 * @param plugin - Plugin returned by `viteImportMapPlugin`.
 * @param bundle - Bundle to pass to the hook.
 */
function callGenerateBundle(plugin: ReturnType<typeof viteImportMapPlugin>, bundle: OutputBundleLike): void {
  const hook = plugin.generateBundle;
  if (typeof hook !== 'function') {
    throw new Error('generateBundle hook is not a function - adjust test helper');
  }
  // Call with minimal context: options is unused, isWrite is unused.
  (hook as (opts: unknown, bundle: OutputBundleLike) => void)({}, bundle);
}

/** Return type from the transformIndexHtml handler when tags are injected. */
interface HtmlTagResult {
  html: string;
  tags: ReadonlyArray<{
    tag: string;
    attrs?: Record<string, string>;
    children?: string;
    injectTo?: string;
  }>;
}

/**
 * Extract and invoke the `transformIndexHtml` handler from a plugin.
 *
 * Returns the raw result: either a plain string (no-op) or a
 * `{ html, tags }` tag descriptor object.
 * @param plugin - Plugin returned by `viteImportMapPlugin`.
 * @param html - HTML string to transform.
 * @returns Raw handler result - string or HtmlTagResult.
 */
function callTransformIndexHtml(plugin: ReturnType<typeof viteImportMapPlugin>, html: string): string | HtmlTagResult {
  const hook = plugin.transformIndexHtml;
  if (typeof hook !== 'object' || hook === null || !('handler' in hook)) {
    throw new Error('transformIndexHtml hook is not an object with handler - adjust test helper');
  }
  return (hook as { handler: (html: string) => string | HtmlTagResult }).handler(html);
}

/**
 * Invoke `configResolved` with a minimal Vite config containing a `base` path.
 * @param plugin - Plugin returned by `viteImportMapPlugin`.
 * @param base - The Vite base path to configure.
 */
function callConfigResolved(plugin: ReturnType<typeof viteImportMapPlugin>, base: string): void {
  const hook = plugin.configResolved;
  if (typeof hook !== 'function') {
    throw new Error('configResolved hook is not a function - adjust test helper');
  }
  (hook as (config: { base: string }) => void)({ base });
}

/**
 * Invoke the plugin `config` hook and return the merged Rollup input object.
 * @param plugin - Plugin returned by `viteImportMapPlugin`.
 * @param input - Existing host Rollup input.
 * @returns Rollup input after shared browser facade entries are added.
 */
function callConfigHook(
  plugin: ReturnType<typeof viteImportMapPlugin>,
  input: string | readonly string[] | Record<string, string> | undefined,
): Record<string, string> {
  const hook = plugin.config;
  if (typeof hook !== 'function') {
    throw new Error('config hook is not a function - adjust test helper');
  }
  const configHook = hook as (
    this: object,
    config: { build: { rollupOptions: { input: typeof input } } },
    env: { command: 'build'; mode: 'production' },
  ) => unknown;
  const result = configHook.call({}, { build: { rollupOptions: { input } } }, { command: 'build', mode: 'production' });
  const config = result as { build?: { rollupOptions?: { input?: Record<string, string> } } };
  const mergedInput = config.build?.rollupOptions?.input;
  if (mergedInput === undefined) {
    throw new Error('config hook did not return merged input');
  }
  return mergedInput;
}

describe('viteImportMapPlugin', () => {
  it('has apply: "build" so it is a no-op in dev mode', () => {
    const plugin = viteImportMapPlugin();
    expect(plugin.apply).toBe('build');
  });

  it('has the correct plugin name', () => {
    const plugin = viteImportMapPlugin();
    expect(plugin.name).toBe('makaio:import-map');
  });

  it('adds shared browser facade entries without dropping host inputs', () => {
    const plugin = viteImportMapPlugin();

    const input = callConfigHook(plugin, { main: '/repo/index.html', 'extensions/foo': '/repo/extensions/foo.js' });

    expect(input.main).toBe('/repo/index.html');
    expect(input['extensions/foo']).toBe('/repo/extensions/foo.js');
    expect(input.__makaio_shared_react).toBe('react');
    expect(input.__makaio_shared_react_dom).toBe('react-dom');
    expect(input.__makaio_shared_react_jsx_runtime).toBe('react/jsx-runtime');
    expect(input.__makaio_shared_makaio_web_framework).toBe('@makaio/web-framework');
  });

  it('returns a tag descriptor with importmap type and head-prepend injection', () => {
    const plugin = viteImportMapPlugin();

    const bundle = makeBundle([
      { fileName: 'assets/react-abc123.js', facadeModuleId: '/root/node_modules/react/index.js' },
      { fileName: 'assets/react-dom-abc123.js', facadeModuleId: '/root/node_modules/react-dom/index.js' },
    ]);

    callGenerateBundle(plugin, bundle);

    const result = callTransformIndexHtml(plugin, '<head><script type="module" src="/main.js"></script></head>');

    expect(typeof result).not.toBe('string');
    const tagResult = result as HtmlTagResult;
    expect(tagResult.tags).toHaveLength(1);

    const tag = tagResult.tags[0]!;
    expect(tag.tag).toBe('script');
    expect(tag.attrs).toEqual({ type: 'importmap' });
    expect(tag.injectTo).toBe('head-prepend');

    // Children should be valid JSON containing mapped specifiers
    const importMap = JSON.parse(tag.children!) as { imports: Record<string, string> };
    expect(importMap.imports).toHaveProperty('react');
    expect(importMap.imports).toHaveProperty('react-dom');
    expect(importMap.imports['react']).toContain('react-abc123.js');
    expect(Object.keys(importMap.imports)).toEqual(SHARED_BROWSER_EXTERNALS.slice(0, 2));
  });

  it('transformIndexHtml is a no-op string when generateBundle was not called', () => {
    const plugin = viteImportMapPlugin();

    const html = '<head><script src="/main.js"></script></head>';
    const result = callTransformIndexHtml(plugin, html);

    expect(result).toBe(html);
  });

  it('transformIndexHtml has order: "post"', () => {
    const plugin = viteImportMapPlugin();

    const hook = plugin.transformIndexHtml;
    if (typeof hook !== 'object' || hook === null) throw new Error('unexpected hook shape');
    expect((hook as { order?: string }).order).toBe('post');
  });

  it('empty bundle produces an importmap with empty imports object', () => {
    const plugin = viteImportMapPlugin();

    callGenerateBundle(plugin, {});

    const result = callTransformIndexHtml(plugin, '<head><script src="/main.js"></script></head>');

    expect(typeof result).not.toBe('string');
    const tagResult = result as HtmlTagResult;
    const importMap = JSON.parse(tagResult.tags[0]!.children!) as { imports: Record<string, string> };
    expect(importMap.imports).toEqual({});
  });

  it('respects Vite base config for import map URLs', () => {
    const plugin = viteImportMapPlugin();

    callConfigResolved(plugin, '/app/');

    const bundle = makeBundle([
      { fileName: 'assets/react-abc.js', facadeModuleId: '/root/node_modules/react/index.js' },
    ]);

    callGenerateBundle(plugin, bundle);

    const result = callTransformIndexHtml(plugin, '<head></head>');

    expect(typeof result).not.toBe('string');
    const tagResult = result as HtmlTagResult;
    const importMap = JSON.parse(tagResult.tags[0]!.children!) as { imports: Record<string, string> };
    expect(importMap.imports['react']).toMatch(/^\/app\//);
  });

  it('warns when shared deps are missing from bundle', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const plugin = viteImportMapPlugin();

      // Only react is present - react-dom, react/jsx-runtime, @makaio/web-framework are absent.
      const bundle = makeBundle([
        { fileName: 'assets/react-abc123.js', facadeModuleId: '/root/node_modules/react/index.js' },
      ]);

      callGenerateBundle(plugin, bundle);

      const html = '<head></head>';
      const result = callTransformIndexHtml(plugin, html);

      // react should be in the import map (returned as a tag descriptor, not inline HTML)
      expect(typeof result).not.toBe('string');
      const tagResult = result as HtmlTagResult;
      expect(tagResult.tags).toHaveLength(1);
      const importMap = JSON.parse(tagResult.tags[0]!.children!) as { imports: Record<string, string> };
      expect(importMap.imports['react']).toContain('react-abc123.js');

      // Missing deps must not appear in the import map
      expect(importMap.imports['react-dom']).toBeUndefined();
      expect(importMap.imports['react/jsx-runtime']).toBeUndefined();
      expect(importMap.imports['@makaio/web-framework']).toBeUndefined();

      // A warning must be emitted for each missing shared dep.
      expect(warnSpy).toHaveBeenCalledTimes(SHARED_BROWSER_EXTERNALS.length - 1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('react-dom'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('react/jsx-runtime'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('@makaio/web-framework'));

      // react was found - no warning for it
      const reactWarns = warnSpy.mock.calls.filter((args) => {
        const msg = args[0];
        return (
          typeof msg === 'string' &&
          msg.includes('"react"') &&
          !msg.includes('react-dom') &&
          !msg.includes('react/jsx-runtime')
        );
      });
      expect(reactWarns).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

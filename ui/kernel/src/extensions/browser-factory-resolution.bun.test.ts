import { describe, expect, it, mock } from 'bun:test';
import { resolveExtensionBrowserFactory } from './browser-factory-resolution.js';
import type { ExtensionBrowserFactory } from './types.js';

describe('resolveExtensionBrowserFactory', () => {
  it('resolves a callable module default export as the browser factory', () => {
    const moduleFactory: ExtensionBrowserFactory = () => ({});
    const registeredFactory: ExtensionBrowserFactory = () => ({
      widgets: [],
    });

    const result = resolveExtensionBrowserFactory(moduleFactory, registeredFactory);

    expect(result).toEqual({
      factory: moduleFactory,
      kind: 'resolved',
    });
  });

  it('uses the registered factory fallback when the module default export is missing', () => {
    const registeredFactory: ExtensionBrowserFactory = () => ({});

    const result = resolveExtensionBrowserFactory(undefined, registeredFactory);

    expect(result).toEqual({
      factory: registeredFactory,
      kind: 'resolved',
    });
  });

  it('rejects manifest-like default objects when no factory fallback exists', () => {
    const manifestLikeDefault = {
      displayName: 'Legacy Browser Manifest',
      name: 'legacy-browser-manifest',
      ui: {
        widgets: [],
      },
    };

    const result = resolveExtensionBrowserFactory(manifestLikeDefault, undefined);

    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('expected function, got default export object and registry fallback undefined');
    }
  });

  it('does not invoke factories during resolution', () => {
    const moduleFactory: ExtensionBrowserFactory = mock(() => ({}));

    resolveExtensionBrowserFactory(moduleFactory, undefined);

    expect(moduleFactory).not.toHaveBeenCalled();
  });
});

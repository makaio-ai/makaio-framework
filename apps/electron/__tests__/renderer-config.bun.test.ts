import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { readElectronRendererConfig } from '../src/renderer/config.js';

// Bun does not expose `window` in its default runtime. We alias it to
// `globalThis` so that the renderer config module can read and write
// `window.__MAKAIO_CONFIG__` the same way a browser environment would.
beforeAll(() => {
  if (typeof window === 'undefined') {
    // @ts-expect-error — intentional global alias for test environment
    globalThis.window = globalThis;
  }
});

describe('readElectronRendererConfig', () => {
  afterEach(() => {
    delete window.__MAKAIO_CONFIG__;
  });

  it('reads preload-injected config and normalizes the shared renderer shape', () => {
    window.__MAKAIO_CONFIG__ = {
      bootComplete: true,
      busUrl: 'ws://localhost:6200/runtime',
      params: { projectId: 'project-123' },
      windowId: 'test.surface:main',
    };

    expect(readElectronRendererConfig('')).toEqual({
      bootComplete: true,
      busUrl: 'ws://localhost:6200/runtime',
      projectId: 'project-123',
      windowId: 'test.surface:main',
    });
  });

  it('falls back to the Vite bus URL when preload config is absent', () => {
    expect(readElectronRendererConfig('ws://localhost:6200/fallback')).toEqual({
      bootComplete: false,
      busUrl: 'ws://localhost:6200/fallback',
      projectId: null,
      windowId: null,
    });
  });

  it('preserves an empty bus URL for shared bootstrap validation when both sources are absent', () => {
    expect(readElectronRendererConfig('')).toEqual({
      bootComplete: false,
      busUrl: '',
      projectId: null,
      windowId: null,
    });
  });
});

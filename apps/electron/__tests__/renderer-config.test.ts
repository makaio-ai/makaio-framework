// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readElectronRendererConfig } from '../src/renderer/config.js';

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

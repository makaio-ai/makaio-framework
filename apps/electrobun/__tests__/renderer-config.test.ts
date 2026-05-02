// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readElectrobunRendererConfig } from '../src/renderer/config.js';

describe('readElectrobunRendererConfig', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('reads runtime config from the Electrobun URL query string', () => {
    window.history.replaceState(
      {},
      '',
      '/index.html?app=test.surface&busUrl=ws%3A%2F%2Fbus.test%2Fruntime&window=test.surface%3Amain&projectId=project-123&bootComplete=1',
    );

    expect(readElectrobunRendererConfig('')).toEqual({
      bootComplete: true,
      busUrl: 'ws://bus.test/runtime',
      projectId: 'project-123',
      windowId: 'test.surface:main',
    });
  });

  it('keeps the standalone-dev bus URL fallback when the host omits busUrl', () => {
    window.history.replaceState({}, '', '/index.html?projectId=project-123');

    expect(readElectrobunRendererConfig('')).toEqual({
      bootComplete: false,
      busUrl: `ws://${window.location.host}/bus`,
      projectId: 'project-123',
      windowId: null,
    });
  });

  it('uses the Vite fallback when the query param is explicitly empty', () => {
    window.history.replaceState({}, '', '/index.html?busUrl=');

    expect(readElectrobunRendererConfig('ws://vite.test/runtime')).toEqual({
      bootComplete: false,
      busUrl: 'ws://vite.test/runtime',
      projectId: null,
      windowId: null,
    });
  });
});

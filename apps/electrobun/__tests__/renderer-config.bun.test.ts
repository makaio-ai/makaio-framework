import { afterEach, describe, expect, it } from 'bun:test';

// Minimal DOM stub for window.location and window.history.
// The renderer config only reads window.location.search and window.location.host,
// and the tests mutate state via window.history.replaceState.
let currentUrl = new URL('http://localhost/');

const locationStub = {
  get search(): string {
    return currentUrl.search;
  },
  get host(): string {
    return currentUrl.host;
  },
  get href(): string {
    return currentUrl.href;
  },
};

const historyStub = {
  replaceState(_state: unknown, _title: string, url: string): void {
    currentUrl = new URL(url, 'http://localhost/');
  },
};

// Install DOM globals before importing the module under test.
Object.defineProperty(globalThis, 'window', {
  value: {
    get location() {
      return locationStub;
    },
    history: historyStub,
  },
  configurable: true,
  writable: true,
});

import { readElectrobunRendererConfig, readElectrobunSurfaceHint } from '../src/renderer/config.js';

describe('readElectrobunRendererConfig', () => {
  afterEach(() => {
    currentUrl = new URL('http://localhost/');
  });

  it('reads runtime config from the Electrobun URL query string', () => {
    historyStub.replaceState(
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
    historyStub.replaceState({}, '', '/index.html?projectId=project-123');

    expect(readElectrobunRendererConfig('')).toEqual({
      bootComplete: false,
      busUrl: `ws://${locationStub.host}/bus`,
      projectId: 'project-123',
      windowId: null,
    });
  });

  it('uses the Vite fallback when the query param is explicitly empty', () => {
    historyStub.replaceState({}, '', '/index.html?busUrl=');

    expect(readElectrobunRendererConfig('ws://vite.test/runtime')).toEqual({
      bootComplete: false,
      busUrl: 'ws://vite.test/runtime',
      projectId: null,
      windowId: null,
    });
  });

  it('defaults to the Electrobun dashboard surface', () => {
    historyStub.replaceState({}, '', '/index.html');

    expect(readElectrobunSurfaceHint()).toBe('electrobun');
  });

  it('reads the tray surface hint from the Electrobun URL query string', () => {
    historyStub.replaceState({}, '', '/index.html?surface=tray');

    expect(readElectrobunSurfaceHint()).toBe('tray');
  });

  it('falls back to the Electrobun dashboard surface for unknown hints', () => {
    historyStub.replaceState({}, '', '/index.html?surface=unknown');

    expect(readElectrobunSurfaceHint()).toBe('electrobun');
  });
});

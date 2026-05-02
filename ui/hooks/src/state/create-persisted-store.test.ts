// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { createPersistedStore } from './create-persisted-store.js';

type TestStore = {
  value: number;
  setValue: (value: number) => void;
};

describe('createPersistedStore', () => {
  const probeKey = '__makaio_storage_probe__';
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

  afterEach(() => {
    if (localStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    }
    if (sessionStorageDescriptor) {
      Object.defineProperty(globalThis, 'sessionStorage', sessionStorageDescriptor);
    }
    localStorage.removeItem(probeKey);
    sessionStorage.removeItem(probeKey);
  });

  it('preserves existing localStorage probe key value', () => {
    localStorage.setItem(probeKey, 'existing-local-value');

    createPersistedStore<TestStore>(
      (set) => ({
        value: 0,
        setValue: (value) => set({ value }),
      }),
      { name: 'test-local-storage-probe-preserve', storage: 'localStorage' },
    );

    expect(localStorage.getItem(probeKey)).toBe('existing-local-value');
  });

  it('preserves existing sessionStorage probe key value', () => {
    sessionStorage.setItem(probeKey, 'existing-session-value');

    createPersistedStore<TestStore>(
      (set) => ({
        value: 0,
        setValue: (value) => set({ value }),
      }),
      { name: 'test-session-storage-probe-preserve', storage: 'sessionStorage' },
    );

    expect(sessionStorage.getItem(probeKey)).toBe('existing-session-value');
  });

  it('falls back safely when localStorage access throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage denied');
      },
    });

    const useStore = createPersistedStore<TestStore>(
      (set) => ({
        value: 0,
        setValue: (value) => set({ value }),
      }),
      { name: 'test-local-storage-fallback', storage: 'localStorage' },
    );

    expect(() => useStore.getState().setValue(1)).not.toThrow();
    expect(useStore.getState().value).toBe(1);
  });

  it('falls back safely when sessionStorage access throws', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage denied');
      },
    });

    const useStore = createPersistedStore<TestStore>(
      (set) => ({
        value: 0,
        setValue: (value) => set({ value }),
      }),
      { name: 'test-session-storage-fallback', storage: 'sessionStorage' },
    );

    expect(() => useStore.getState().setValue(1)).not.toThrow();
    expect(useStore.getState().value).toBe(1);
  });
});

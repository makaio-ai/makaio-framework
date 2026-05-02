import { describe, expect, it } from 'vitest';
import {
  SHARED_BROWSER_EXTERNALS,
  isSharedBrowserExternal,
  toSharedBrowserExternalEntryName,
} from '../browser-shared-externals.js';

describe('SHARED_BROWSER_EXTERNALS', () => {
  it('defines the canonical shared browser dependency contract in stable order', () => {
    expect(SHARED_BROWSER_EXTERNALS).toEqual(['react', 'react-dom', 'react/jsx-runtime', '@makaio/web-framework']);
  });
});

describe('isSharedBrowserExternal', () => {
  it('accepts every supported shared browser dependency', () => {
    for (const specifier of SHARED_BROWSER_EXTERNALS) {
      expect(isSharedBrowserExternal(specifier)).toBe(true);
    }
  });

  it('rejects unsupported bare specifiers and subpaths', () => {
    expect(isSharedBrowserExternal('react-dom/client')).toBe(false);
    expect(isSharedBrowserExternal('@makaio/web-framework/testing')).toBe(false);
    expect(isSharedBrowserExternal('zod')).toBe(false);
  });
});

describe('toSharedBrowserExternalEntryName', () => {
  it('derives stable non-overlapping facade entry names', () => {
    expect(toSharedBrowserExternalEntryName('react')).toBe('__makaio_shared_react');
    expect(toSharedBrowserExternalEntryName('react-dom')).toBe('__makaio_shared_react_dom');
    expect(toSharedBrowserExternalEntryName('react/jsx-runtime')).toBe('__makaio_shared_react_jsx_runtime');
    expect(toSharedBrowserExternalEntryName('@makaio/web-framework')).toBe('__makaio_shared_makaio_web_framework');
  });
});

import { describe, expect, it } from 'bun:test';
import {
  SHARED_BROWSER_EXTERNALS,
  isSharedBrowserExternal,
  toSharedBrowserExternalEntryName,
} from '../browser-shared-externals.js';

describe('SHARED_BROWSER_EXTERNALS', () => {
  it('defines the canonical shared browser dependency contract in stable order', () => {
    expect(SHARED_BROWSER_EXTERNALS).toEqual([
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@makaio/ui-kernel',
      '@makaio/ui-hooks',
      '@makaio/ui-components',
      '@makaio/ui-views',
    ]);
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
    expect(isSharedBrowserExternal('@makaio/ui-kernel/testing')).toBe(false);
    expect(isSharedBrowserExternal('@makaio/web-framework')).toBe(false); // makaio-boundary-allow-line: negative fixture for rejecting legacy browser externals
    expect(isSharedBrowserExternal('zod')).toBe(false);
  });
});

describe('toSharedBrowserExternalEntryName', () => {
  it('derives stable non-overlapping facade entry names', () => {
    expect(toSharedBrowserExternalEntryName('react')).toBe('__makaio_shared_react');
    expect(toSharedBrowserExternalEntryName('react-dom')).toBe('__makaio_shared_react_dom');
    expect(toSharedBrowserExternalEntryName('react/jsx-runtime')).toBe('__makaio_shared_react_jsx_runtime');
    expect(toSharedBrowserExternalEntryName('@makaio/ui-kernel')).toBe('__makaio_shared_makaio_ui_kernel');
    expect(toSharedBrowserExternalEntryName('@makaio/ui-hooks')).toBe('__makaio_shared_makaio_ui_hooks');
    expect(toSharedBrowserExternalEntryName('@makaio/ui-components')).toBe('__makaio_shared_makaio_ui_components');
    expect(toSharedBrowserExternalEntryName('@makaio/ui-views')).toBe('__makaio_shared_makaio_ui_views');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { pageDefinitionRegistry, type PageDefinition } from '@makaio/ui-kernel';
import { usePageComponent } from './use-page-component.js';

function buildPage(overrides: Partial<PageDefinition> = {}): PageDefinition {
  return {
    id: 'test-page',
    name: 'Test Page',
    mode: 'peek',
    level: 'any',
    component: async () => ({ default: () => null }),
    ...overrides,
  };
}

describe('usePageComponent', () => {
  afterEach(() => {
    pageDefinitionRegistry.clear();
    vi.restoreAllMocks();
  });

  it('does not subscribe to the registry when pageId is null', () => {
    const subscribeSpy = vi.spyOn(pageDefinitionRegistry, 'subscribe');

    const { result } = renderHook(() => usePageComponent(null));

    expect(result.current).toBeUndefined();
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it('returns the resolved page definition for an active page', () => {
    pageDefinitionRegistry.register(
      buildPage({
        id: 'settings',
        name: 'Settings',
      }),
    );

    const { result } = renderHook(() => usePageComponent('settings'));

    expect(result.current?.definition.id).toBe('settings');
    expect(result.current?.Component).toBeDefined();
  });
});

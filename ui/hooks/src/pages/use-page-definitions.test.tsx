// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { pageDefinitionRegistry, type PageDefinition } from '@makaio/ui-kernel';
import { usePageDefinitions } from './use-page-definitions.js';

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

describe('usePageDefinitions', () => {
  afterEach(() => {
    pageDefinitionRegistry.clear();
  });

  it('re-evaluates dynamic visibility on rerender', () => {
    let visible = false;

    pageDefinitionRegistry.register(
      buildPage({
        id: 'conditional',
        when: () => visible,
      }),
    );

    const { result, rerender } = renderHook(() => usePageDefinitions({ mode: 'peek' }));

    expect(result.current).toHaveLength(0);

    visible = true;
    rerender();

    expect(result.current.map((page) => page.id)).toEqual(['conditional']);
  });
});

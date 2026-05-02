import { describe, expectTypeOf, it } from 'vitest';
import type {
  PageDeclaration,
  TileDeclaration,
  UiContextDimension,
  UiContextSnapshot,
  UiNavigationLevel,
  UiRuntimeNavigationLevel,
  UiScope,
  WidgetDeclaration,
} from '@makaio/contracts';
import type {
  UiContextDimension as ExtensionUiContextDimension,
  UiNavigationLevel as ExtensionUiNavigationLevel,
  UiRuntimeNavigationLevel as ExtensionUiRuntimeNavigationLevel,
  UiScope as ExtensionUiScope,
} from '@makaio/contracts/extension';

declare module '@makaio/contracts' {
  interface UiScopeMap {
    project: true;
  }

  interface UiNavigationLevelMap {
    worktree: true;
  }

  interface UiContextValueMap {
    project: string;
    workingDirectory: string;
  }
}

describe('UI contribution context declaration merging', () => {
  it('includes framework-owned defaults in the augmented public contract', () => {
    expectTypeOf<'global'>().toMatchTypeOf<UiScope>();
    expectTypeOf<'any'>().toMatchTypeOf<UiScope>();
    expectTypeOf<'root'>().toMatchTypeOf<UiNavigationLevel>();
    expectTypeOf<'any'>().toMatchTypeOf<UiNavigationLevel>();
    expectTypeOf<'root'>().toMatchTypeOf<UiRuntimeNavigationLevel>();
    expectTypeOf<'any'>().not.toMatchTypeOf<UiRuntimeNavigationLevel>();
    expectTypeOf<'session'>().toMatchTypeOf<UiContextDimension>();
  });

  it('extends UI scope, navigation level, and context dimensions through the root barrel', () => {
    expectTypeOf<'project'>().toMatchTypeOf<UiScope>();
    expectTypeOf<'worktree'>().toMatchTypeOf<UiNavigationLevel>();
    expectTypeOf<'worktree'>().toMatchTypeOf<UiRuntimeNavigationLevel>();
    expectTypeOf<'workingDirectory'>().toMatchTypeOf<UiContextDimension>();
  });

  it('extends UI context types through the extension barrel', () => {
    expectTypeOf<'project'>().toMatchTypeOf<ExtensionUiScope>();
    expectTypeOf<'worktree'>().toMatchTypeOf<ExtensionUiNavigationLevel>();
    expectTypeOf<'worktree'>().toMatchTypeOf<ExtensionUiRuntimeNavigationLevel>();
    expectTypeOf<'any'>().not.toMatchTypeOf<ExtensionUiRuntimeNavigationLevel>();
    expectTypeOf<'workingDirectory'>().toMatchTypeOf<ExtensionUiContextDimension>();
  });

  it('keeps UI scope and navigation types narrower than plain string', () => {
    expectTypeOf<string>().not.toMatchTypeOf<UiScope>();
    expectTypeOf<string>().not.toMatchTypeOf<UiNavigationLevel>();
    expectTypeOf<string>().not.toMatchTypeOf<UiRuntimeNavigationLevel>();
    expectTypeOf<string>().not.toMatchTypeOf<UiContextDimension>();
  });

  it('uses augmented keys in contribution declarations', () => {
    const widget = {
      id: 'widget',
      name: 'Widget',
      scope: 'project',
      definition: {
        sizes: ['small'],
        defaultSize: 'small',
      },
      renderers: {
        react: async () => ({ default: () => null }),
      },
    } satisfies WidgetDeclaration;

    const page = {
      id: 'page',
      name: 'Page',
      scope: 'project',
      slots: [],
      defaultContent: {},
      mode: 'switch',
      level: 'worktree',
      component: async () => ({ default: () => null }),
    } satisfies PageDeclaration;

    const tile = {
      id: 'tile',
      name: 'Tile',
      scope: 'project',
      icon: async () => ({ default: () => null }),
      contextDependencies: ['workingDirectory'],
      renderers: {
        react: async () => ({ default: () => null }),
      },
    } satisfies TileDeclaration;

    expectTypeOf(widget.scope).toEqualTypeOf<'project'>();
    expectTypeOf(page.level).toEqualTypeOf<'worktree'>();
    expectTypeOf(tile.contextDependencies).toMatchTypeOf<UiContextDimension[]>();
  });

  it('types context snapshot values by registered context key', () => {
    const snapshot = {
      level: 'worktree',
      values: {
        project: 'project-1',
        workingDirectory: '/repo',
      },
    } satisfies UiContextSnapshot;

    expectTypeOf<UiContextSnapshot['level']>().toEqualTypeOf<UiRuntimeNavigationLevel>();
    expectTypeOf<'any'>().not.toMatchTypeOf<UiContextSnapshot['level']>();
    expectTypeOf(snapshot.values.project).toEqualTypeOf<string>();
  });
});

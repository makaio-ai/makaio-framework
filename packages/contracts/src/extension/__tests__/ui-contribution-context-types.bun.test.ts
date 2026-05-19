import { describe, it } from 'bun:test';
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

/**
 * Assert that `T` is assignable to `U` at compile time (no-op at runtime).
 * If `T` is not assignable to `U`, TypeScript raises a type error.
 */
function assertAssignable<_T extends U, U>(): void {}

/**
 * Assert that `T` is NOT assignable to `U` at compile time (no-op at runtime).
 * Uses a conditional type to invert the assignability relationship.
 */
function assertNotAssignable<T, U>(): [T] extends [U] ? never : void {
  return undefined as never;
}

describe('UI contribution context declaration merging', () => {
  it('includes framework-owned defaults in the augmented public contract', () => {
    // 'global' ⊆ UiScope
    assertAssignable<'global', UiScope>();
    // 'any' ⊆ UiScope
    assertAssignable<'any', UiScope>();
    // 'root' ⊆ UiNavigationLevel
    assertAssignable<'root', UiNavigationLevel>();
    // 'any' ⊆ UiNavigationLevel
    assertAssignable<'any', UiNavigationLevel>();
    // 'root' ⊆ UiRuntimeNavigationLevel
    assertAssignable<'root', UiRuntimeNavigationLevel>();
    // 'any' is NOT ⊆ UiRuntimeNavigationLevel
    assertNotAssignable<'any', UiRuntimeNavigationLevel>();
    // 'session' ⊆ UiContextDimension
    assertAssignable<'session', UiContextDimension>();
  });

  it('extends UI scope, navigation level, and context dimensions through the root barrel', () => {
    assertAssignable<'project', UiScope>();
    assertAssignable<'worktree', UiNavigationLevel>();
    assertAssignable<'worktree', UiRuntimeNavigationLevel>();
    assertAssignable<'workingDirectory', UiContextDimension>();
  });

  it('extends UI context types through the extension barrel', () => {
    assertAssignable<'project', ExtensionUiScope>();
    assertAssignable<'worktree', ExtensionUiNavigationLevel>();
    assertAssignable<'worktree', ExtensionUiRuntimeNavigationLevel>();
    assertNotAssignable<'any', ExtensionUiRuntimeNavigationLevel>();
    assertAssignable<'workingDirectory', ExtensionUiContextDimension>();
  });

  it('keeps UI scope and navigation types narrower than plain string', () => {
    assertNotAssignable<string, UiScope>();
    assertNotAssignable<string, UiNavigationLevel>();
    assertNotAssignable<string, UiRuntimeNavigationLevel>();
    assertNotAssignable<string, UiContextDimension>();
  });

  it('uses augmented keys in contribution declarations', () => {
    const _widget = {
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

    const _page = {
      id: 'page',
      name: 'Page',
      scope: 'project',
      slots: [],
      defaultContent: {},
      mode: 'switch',
      level: 'worktree',
      component: async () => ({ default: () => null }),
    } satisfies PageDeclaration;

    const _tile = {
      id: 'tile',
      name: 'Tile',
      scope: 'project',
      icon: async () => ({ default: () => null }),
      contextDependencies: ['workingDirectory'],
      renderers: {
        react: async () => ({ default: () => null }),
      },
    } satisfies TileDeclaration;

    // Compile-time shape checks via type assertions
    assertAssignable<typeof _widget.scope, 'project'>();
    assertAssignable<'project', typeof _widget.scope>();
    assertAssignable<typeof _page.level, 'worktree'>();
    assertAssignable<'worktree', typeof _page.level>();
    assertAssignable<typeof _tile.contextDependencies, UiContextDimension[]>();
  });

  it('types context snapshot values by registered context key', () => {
    const _snapshot = {
      level: 'worktree',
      values: {
        project: 'project-1',
        workingDirectory: '/repo',
      },
    } satisfies UiContextSnapshot;

    assertAssignable<UiContextSnapshot['level'], UiRuntimeNavigationLevel>();
    assertAssignable<UiRuntimeNavigationLevel, UiContextSnapshot['level']>();
    assertNotAssignable<'any', UiContextSnapshot['level']>();
    assertAssignable<typeof _snapshot.values.project, string>();
    assertAssignable<string, typeof _snapshot.values.project>();
  });
});

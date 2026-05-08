import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PageDefinitionRegistry } from './PageDefinitionRegistry.js';
import { isOverlayMode, type PageDefinition } from './page-definition-types.js';

declare module '@makaio/contracts' {
  interface UiNavigationLevelMap {
    detail: true;
    workspace: true;
  }
}

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

describe('PageDefinitionRegistry', () => {
  let registry: PageDefinitionRegistry;

  beforeEach(() => {
    registry = new PageDefinitionRegistry();
  });

  it('registers and retrieves pages', () => {
    const page = buildPage();
    registry.register(page);

    expect(registry.get(page.id)).toMatchObject({
      id: page.id,
      name: page.name,
      order: 50,
      group: 'navigate',
    });
    expect(registry.has(page.id)).toBe(true);
  });

  it('accepts sheet-mode pages and classifies them as overlays', () => {
    const page = buildPage({ id: 'sheet-page', mode: 'sheet' });
    const peekPage = buildPage({ id: 'peek-page', mode: 'peek' });

    registry.register(page);
    registry.register(peekPage);

    const sheetIds = registry.query({ mode: 'sheet' }).map((result) => result.id);
    expect(sheetIds).toEqual(['sheet-page']);
    expect(sheetIds).not.toContain('peek-page');
    expect(isOverlayMode('sheet')).toBe(true);
    expect(isOverlayMode('switch')).toBe(false);
  });

  it('throws on duplicate registration', () => {
    const page = buildPage();
    registry.register(page);

    expect(() => registry.register(page)).toThrow();
  });

  it('throws when level is whitespace-only', () => {
    const page = buildPage({ id: 'blank-level', level: '   ' as never });

    expect(() => registry.register(page)).toThrow('must have a non-empty level');
  });

  it('filters by level and includes any', () => {
    const anyPage = buildPage({ id: 'any', level: 'any' });
    const workspacePage = buildPage({ id: 'workspace', level: 'workspace' });
    const detailPage = buildPage({ id: 'detail', level: 'detail' });

    registry.register(anyPage);
    registry.register(workspacePage);
    registry.register(detailPage);

    const workspaceResults = registry.query({ level: 'workspace' });
    const workspaceIds = workspaceResults.map((page) => page.id);
    expect(workspaceIds).toContain('any');
    expect(workspaceIds).toContain('workspace');
    expect(workspaceIds).not.toContain('detail');
  });

  it('filters by surface when surfaces are declared', () => {
    const webOnly = buildPage({ id: 'web-only', surface: { surfaces: ['web'] } });
    const mobileOnly = buildPage({ id: 'mobile-only', surface: { surfaces: ['mobile'] } });
    const bothSurfaces = buildPage({ id: 'both', surface: { surfaces: ['web', 'mobile'] } });
    const allSurfaces = buildPage({ id: 'all' }); // no surface config = available everywhere

    registry.register(webOnly);
    registry.register(mobileOnly);
    registry.register(bothSurfaces);
    registry.register(allSurfaces);

    const webResults = registry.query({ surface: 'web' });
    const webIds = webResults.map((p) => p.id);
    expect(webIds).toContain('web-only');
    expect(webIds).toContain('both');
    expect(webIds).toContain('all');
    expect(webIds).not.toContain('mobile-only');

    const mobileResults = registry.query({ surface: 'mobile' });
    const mobileIds = mobileResults.map((p) => p.id);
    expect(mobileIds).toContain('mobile-only');
    expect(mobileIds).toContain('both');
    expect(mobileIds).toContain('all');
    expect(mobileIds).not.toContain('web-only');
  });

  it('copies surface metadata so later caller mutations do not leak into the registry', () => {
    const surfaces: Array<'web' | 'mobile'> = ['web'];
    const page = buildPage({ id: 'surface-copy', surface: { surfaces } });

    registry.register(page);
    surfaces.push('mobile');

    expect(registry.get('surface-copy')?.surface?.surfaces).toEqual(['web']);
    expect(registry.query({ surface: 'mobile' }).map((p) => p.id)).not.toContain('surface-copy');
  });

  it('returns frozen snapshots so callers cannot mutate cached registry results', () => {
    registry.register(buildPage({ id: 'frozen-page' }));

    const snapshot = registry.getAll();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it('excludes pages with requiredCapabilities when filtering by surface ID alone', () => {
    // Safe default: capability-gated pages are excluded from SurfaceId-only queries.
    // Use isPageVisibleOnSurface(page, surfaceDeclaration) at the surface runtime
    // to include capability-gated pages with their full capability set.
    const capPage = buildPage({ id: 'cap-page', surface: { requiredCapabilities: ['dom'] } });
    registry.register(capPage);

    const results = registry.query({ surface: 'mobile' });
    expect(results.map((p) => p.id)).not.toContain('cap-page');
  });

  it('throws when surface sets both surfaces and requiredCapabilities', () => {
    const ambiguous = buildPage({
      id: 'ambiguous',
      surface: { surfaces: ['web'], requiredCapabilities: ['dom'] },
    });
    expect(() => registry.register(ambiguous)).toThrow(
      'surface must specify exactly one of "surfaces" or "requiredCapabilities"',
    );
  });

  it('throws when surface is an empty object (neither field set)', () => {
    const page = buildPage({ id: 'empty-surface', surface: {} });
    expect(() => registry.register(page)).toThrow(
      'surface must specify exactly one of "surfaces" or "requiredCapabilities"',
    );
  });

  it('throws when surface.surfaces is an empty array', () => {
    const page = buildPage({ id: 'empty-surfaces-array', surface: { surfaces: [] } });
    expect(() => registry.register(page)).toThrow('surface.surfaces must be a non-empty array');
  });

  it('throws when surface.requiredCapabilities is an empty array', () => {
    const page = buildPage({ id: 'empty-caps-array', surface: { requiredCapabilities: [] } });
    expect(() => registry.register(page)).toThrow('surface.requiredCapabilities must be a non-empty array');
  });

  it('accepts a surface config with only surfaces set', () => {
    const page = buildPage({ id: 'web-only', surface: { surfaces: ['web'] } });
    expect(() => registry.register(page)).not.toThrow();
  });

  it('accepts a surface config with only requiredCapabilities set', () => {
    const page = buildPage({ id: 'cap-only', surface: { requiredCapabilities: ['dom'] } });
    expect(() => registry.register(page)).not.toThrow();
  });

  it('returns all pages when no surface filter is applied', () => {
    const webOnly = buildPage({ id: 'web-only', surface: { surfaces: ['web'] } });
    const mobileOnly = buildPage({ id: 'mobile-only', surface: { surfaces: ['mobile'] } });

    registry.register(webOnly);
    registry.register(mobileOnly);

    const results = registry.query();
    expect(results).toHaveLength(2);
  });

  it('combines surface and level filters', () => {
    const webWorkspace = buildPage({ id: 'web-workspace', level: 'workspace', surface: { surfaces: ['web'] } });
    const mobileAny = buildPage({ id: 'mobile-any', level: 'any', surface: { surfaces: ['mobile'] } });
    const webAny = buildPage({ id: 'web-any', level: 'any', surface: { surfaces: ['web'] } });

    registry.register(webWorkspace);
    registry.register(mobileAny);
    registry.register(webAny);

    const results = registry.query({ surface: 'web', level: 'workspace' });
    const ids = results.map((p) => p.id);
    expect(ids).toContain('web-workspace');
    expect(ids).toContain('web-any'); // level 'any' matches all
    expect(ids).not.toContain('mobile-any'); // wrong surface
  });

  it('hides pages when when() throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const page = buildPage({
      id: 'throwing',
      when: () => {
        throw new Error('boom');
      },
    });

    registry.register(page);

    const results = registry.query();
    expect(results).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  describe('multi-surface proof of concept', () => {
    it('demonstrates mobile-only, web-only, and cross-surface pages', () => {
      // Mobile-only: native connection settings (would use RN component on mobile)
      const connectionSettings = buildPage({
        id: 'connection-settings',
        name: 'Connection Settings',
        mode: 'peek',
        level: 'any',
        surface: { surfaces: ['mobile'] },
      });

      // Web-only: full workspace with complex slot layout
      const workspace = buildPage({
        id: 'workspace',
        name: 'Workspace',
        mode: 'switch',
        level: 'workspace',
        surface: { surfaces: ['web', 'electron'] },
      });

      // Cross-surface: chat works everywhere (no surface restriction)
      const chat = buildPage({
        id: 'chat',
        name: 'Chat',
        mode: 'switch',
        level: 'any',
      });

      registry.register(connectionSettings);
      registry.register(workspace);
      registry.register(chat);

      // Mobile sees: connection-settings + chat (not workspace)
      const mobilePages = registry.query({ surface: 'mobile' });
      const mobileIds = mobilePages.map((p) => p.id);
      expect(mobileIds).toEqual(['connection-settings', 'chat']);

      // Web sees: workspace + chat (not connection-settings)
      const webPages = registry.query({ surface: 'web' });
      const webIds = webPages.map((p) => p.id);
      expect(webIds).toEqual(['workspace', 'chat']);

      // Electron sees: workspace + chat (not connection-settings)
      const electronPages = registry.query({ surface: 'electron' });
      const electronIds = electronPages.map((p) => p.id);
      expect(electronIds).toEqual(['workspace', 'chat']);

      // No filter: all pages returned
      const allPages = registry.query();
      expect(allPages).toHaveLength(3);
    });
  });
});

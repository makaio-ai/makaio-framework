import { describe, it, expect, beforeEach } from 'vitest';
import { PageRegistry } from './PageRegistry.js';
import type { PageDeclaration } from './types.js';

declare module '@makaio/contracts' {
  interface UiNavigationLevelMap {
    workspace: true;
  }
}

function buildPage(overrides: Partial<PageDeclaration> = {}): PageDeclaration {
  return {
    id: 'test-page',
    name: 'Test Page',
    scope: 'global',
    route: '/test',
    slots: [
      {
        id: 'main',
        name: 'Main',
        acceptsSizes: ['small', 'medium'],
        minColumnWidth: 200,
        maxColumns: 4,
      },
    ],
    defaultContent: {
      main: [
        {
          instanceId: 'test-widget-default',
          content: { type: 'widget', widgetId: 'test-widget' },
          mandatory: true,
        },
      ],
    },
    ...overrides,
  };
}

describe('PageRegistry', () => {
  let registry: PageRegistry;

  beforeEach(() => {
    registry = new PageRegistry();
  });

  it('registers and retrieves pages', () => {
    const page = buildPage();
    registry.register(page);

    expect(registry.get(page.id)).toBe(page);
    expect(registry.has(page.id)).toBe(true);
  });

  it('throws on duplicate registration', () => {
    const page = buildPage();
    registry.register(page);

    expect(() => registry.register(page)).toThrow();
  });

  it('throws on duplicate route registration', () => {
    const first = buildPage({ id: 'first', route: '/duplicate' });
    const second = buildPage({ id: 'second', route: '/duplicate' });
    registry.register(first);
    expect(() => registry.register(second)).toThrow('Route "/duplicate" is already registered by page "first"');
  });

  it('allows multiple pages without a route', () => {
    const a = buildPage({ id: 'a', route: undefined });
    const b = buildPage({ id: 'b', route: undefined });
    expect(() => {
      registry.register(a);
      registry.register(b);
    }).not.toThrow();
  });

  it('validates defaultContent slot IDs', () => {
    const page = buildPage({
      defaultContent: {
        'sidebar-left': [
          {
            instanceId: 'invalid-slot',
            content: { type: 'widget', widgetId: 'test-widget' },
            mandatory: false,
          },
        ],
      },
    });

    expect(() => registry.register(page)).toThrow();
  });

  it('validates slot definitions', () => {
    const page = buildPage({
      slots: [
        {
          id: 'main',
          name: 'Main',
          acceptsSizes: ['small'],
          minColumnWidth: 0,
          maxColumns: 2,
        },
      ],
    });

    expect(() => registry.register(page)).toThrow();
  });

  it('returns only routable pages', () => {
    const routable = buildPage({ id: 'routable', route: '/r' });
    const embedded = buildPage({ id: 'embedded', route: undefined });

    registry.register(routable);
    registry.register(embedded);

    expect(registry.getRoutablePages()).toEqual([routable]);
  });

  describe('getByLevel', () => {
    it('includes pages with matching level', () => {
      const root = buildPage({ id: 'root', route: '/root', level: 'root' });
      const workspace = buildPage({ id: 'workspace', route: '/workspace', level: 'workspace' });
      registry.register(root);
      registry.register(workspace);

      expect(registry.getByLevel('root').map((p) => p.id)).toEqual(['root']);
    });

    it('includes pages with level="any" when includeAny=true (default)', () => {
      const anyLevel = buildPage({ id: 'any', route: '/any', level: 'any' });
      const root = buildPage({ id: 'root', route: '/root', level: 'root' });
      registry.register(anyLevel);
      registry.register(root);

      const results = registry.getByLevel('root').map((p) => p.id);
      expect(results).toContain('any');
      expect(results).toContain('root');
    });

    it('includes pages with level=undefined when includeAny=true (equivalent to "any")', () => {
      const undefinedLevel = buildPage({ id: 'no-level', route: '/no-level', level: undefined });
      registry.register(undefinedLevel);

      expect(registry.getByLevel('root').map((p) => p.id)).toContain('no-level');
    });

    it('excludes pages with level=undefined when includeAny=false', () => {
      const undefinedLevel = buildPage({ id: 'no-level', route: '/no-level', level: undefined });
      registry.register(undefinedLevel);

      expect(registry.getByLevel('root', false).map((p) => p.id)).not.toContain('no-level');
    });

    it('excludes pages with level="any" when includeAny=false', () => {
      const anyLevel = buildPage({ id: 'any', route: '/any', level: 'any' });
      registry.register(anyLevel);

      expect(registry.getByLevel('root', false).map((p) => p.id)).not.toContain('any');
    });
  });

  describe('getAll', () => {
    it('returns a frozen (immutable) snapshot', () => {
      registry.register(buildPage());
      const all = registry.getAll();
      expect(Object.isFrozen(all)).toBe(true);
    });

    it('returns a new snapshot after mutation', () => {
      registry.register(buildPage({ id: 'a', route: '/a' }));
      const first = registry.getAll();
      registry.register(buildPage({ id: 'b', route: '/b' }));
      const second = registry.getAll();
      expect(second).not.toBe(first);
      expect(second).toHaveLength(2);
    });
  });

  describe('clear', () => {
    it('does not notify subscribers when already empty', () => {
      let notifyCount = 0;
      registry.subscribe(() => {
        notifyCount++;
      });

      registry.clear();
      expect(notifyCount).toBe(0);
    });

    it('notifies subscribers and empties registry when not empty', () => {
      registry.register(buildPage());
      let notifyCount = 0;
      registry.subscribe(() => {
        notifyCount++;
      });

      registry.clear();
      expect(notifyCount).toBe(1);
      expect(registry.getAll()).toHaveLength(0);
    });
  });
});

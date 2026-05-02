import { describe, it, expect, beforeEach } from 'vitest';
import { PageSectionRegistry } from './PageSectionRegistry.js';
import type { PageSectionDefinition } from './page-section-types.js';

describe('PageSectionRegistry - Core Functionality', () => {
  // Use a fresh instance for testing to avoid side effects
  let registry: PageSectionRegistry;

  beforeEach(() => {
    registry = new PageSectionRegistry();
  });

  it('should register and retrieve sections by parent', () => {
    const def: PageSectionDefinition = {
      id: 'test-section',
      parentPageId: 'settings',
      name: 'Test Section',
      category: 'system',
      order: 10,
      component: () => null,
    };
    const cleanup = registry.register(def);

    expect(registry.get('settings', 'test-section')).toBe(def);
    expect(registry.has('settings:test-section')).toBe(true);
    expect(registry.getByParent('settings')).toContain(def);

    // Cleanup should work
    cleanup();
    expect(registry.get('settings', 'test-section')).toBeUndefined();
    expect(registry.has('settings:test-section')).toBe(false);
    expect(registry.getByParent('settings')).not.toContain(def);
  });

  it('should register sections for multiple parents and maintain isolation', () => {
    const settingsDef: PageSectionDefinition = {
      id: 'github',
      parentPageId: 'settings',
      name: 'GitHub Settings',
      component: () => null,
    };
    const projectsDef: PageSectionDefinition = {
      id: 'github',
      parentPageId: 'projects',
      name: 'GitHub Projects',
      component: () => null,
    };

    registry.register(settingsDef);
    registry.register(projectsDef);

    // Both should exist independently
    expect(registry.get('settings', 'github')).toBe(settingsDef);
    expect(registry.get('projects', 'github')).toBe(projectsDef);

    // Query by parent should only return sections for that parent
    const settingsSections = registry.getByParent('settings');
    const projectsSections = registry.getByParent('projects');

    expect(settingsSections).toContain(settingsDef);
    expect(settingsSections).not.toContain(projectsDef);
    expect(projectsSections).toContain(projectsDef);
    expect(projectsSections).not.toContain(settingsDef);
  });

  it('should be idempotent on duplicate registration', () => {
    const def: PageSectionDefinition = {
      id: 'test-section',
      parentPageId: 'settings',
      name: 'Test Section',
      category: 'system',
      order: 10,
      component: () => null,
    };
    registry.register(def);
    // Second registration should not throw (StrictMode compatibility)
    expect(() => registry.register(def)).not.toThrow();
    // Should still have only one section
    expect(registry.getByParent('settings')).toHaveLength(1);
  });

  it('should ignore stale cleanups after a section is re-registered', () => {
    const original: PageSectionDefinition = {
      id: 'test-section',
      parentPageId: 'settings',
      name: 'Original Section',
      category: 'system',
      order: 10,
      component: () => null,
    };
    const replacement: PageSectionDefinition = {
      ...original,
      name: 'Replacement Section',
    };

    const cleanup = registry.register(original);
    registry.unregister('settings', 'test-section');
    registry.register(replacement);
    cleanup();

    expect(registry.get('settings', 'test-section')).toBe(replacement);
  });

  it('should sort by order within parent', () => {
    registry.register({
      id: 'c',
      parentPageId: 'settings',
      name: 'C',
      category: 'system',
      order: 30,
      component: () => null,
    });
    registry.register({
      id: 'a',
      parentPageId: 'settings',
      name: 'A',
      category: 'integrations',
      order: 10,
      component: () => null,
    });
    registry.register({
      id: 'b',
      parentPageId: 'settings',
      name: 'B',
      category: 'system',
      order: 20,
      component: () => null,
    });

    const sections = registry.getByParent('settings');
    expect(sections.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('should use default order 100 when not specified', () => {
    registry.register({
      id: 'explicit',
      parentPageId: 'settings',
      name: 'Explicit',
      category: 'system',
      order: 50,
      component: () => null,
    });
    registry.register({
      id: 'default',
      parentPageId: 'settings',
      name: 'Default',
      category: 'system',
      // order omitted - should default to 100
      component: () => null,
    });

    const sections = registry.getByParent('settings');
    expect(sections.map((s) => s.id)).toEqual(['explicit', 'default']);
  });

  it('should filter by parent and category and sort by order', () => {
    const definitions: PageSectionDefinition[] = [
      {
        id: 's1',
        parentPageId: 'settings',
        name: 'System 1',
        category: 'system',
        order: 20,
        component: () => null,
      },
      {
        id: 's2',
        parentPageId: 'settings',
        name: 'Integration 1',
        category: 'integrations',
        order: 10,
        component: () => null,
      },
      {
        id: 's3',
        parentPageId: 'settings',
        name: 'System 2',
        category: 'system',
        order: 10,
        component: () => null,
      },
      {
        id: 's4',
        parentPageId: 'settings',
        name: 'Plugin 1',
        category: 'plugins',
        order: 5,
        component: () => null,
      },
    ];

    for (const def of definitions) {
      registry.register(def);
    }

    const systemSections = registry.getByParentAndCategory('settings', 'system');
    expect(systemSections).toHaveLength(2);
    // Should be sorted by order
    expect(systemSections[0].id).toBe('s3'); // order 10
    expect(systemSections[1].id).toBe('s1'); // order 20

    const integrationSections = registry.getByParentAndCategory('settings', 'integrations');
    expect(integrationSections).toHaveLength(1);
    expect(integrationSections[0].id).toBe('s2');

    const pluginSections = registry.getByParentAndCategory('settings', 'plugins');
    expect(pluginSections).toHaveLength(1);
    expect(pluginSections[0].id).toBe('s4');
  });

  it('should prevent cross-parent collisions with same section ID', () => {
    const settingsDef: PageSectionDefinition = {
      id: 'common',
      parentPageId: 'settings',
      name: 'Settings Common',
      component: () => null,
    };
    const projectsDef: PageSectionDefinition = {
      id: 'common',
      parentPageId: 'projects',
      name: 'Projects Common',
      component: () => null,
    };

    registry.register(settingsDef);
    registry.register(projectsDef);

    // Should have distinct entries
    expect(registry.size()).toBe(2);

    // Each parent should only see its own section
    expect(registry.get('settings', 'common')).toBe(settingsDef);
    expect(registry.get('projects', 'common')).toBe(projectsDef);

    // Unregistering one should not affect the other
    registry.unregister('settings', 'common');
    expect(registry.get('settings', 'common')).toBeUndefined();
    expect(registry.get('projects', 'common')).toBe(projectsDef);
    expect(registry.size()).toBe(1);
  });

  it('should return true when unregistering existing section', () => {
    const def: PageSectionDefinition = {
      id: 'test-section',
      parentPageId: 'settings',
      name: 'Test Section',
      category: 'system',
      order: 10,
      component: () => null,
    };
    registry.register(def);

    const result = registry.unregister('settings', 'test-section');
    expect(result).toBe(true);
    expect(registry.has('settings:test-section')).toBe(false);
    expect(registry.get('settings', 'test-section')).toBeUndefined();
  });

  it('should clear all sections', () => {
    const def1: PageSectionDefinition = {
      id: 'section1',
      parentPageId: 'settings',
      name: 'Section 1',
      category: 'system',
      order: 10,
      component: () => null,
    };
    const def2: PageSectionDefinition = {
      id: 'section2',
      parentPageId: 'projects',
      name: 'Section 2',
      category: 'integrations',
      order: 10,
      component: () => null,
    };

    registry.register(def1);
    registry.register(def2);
    expect(registry.size()).toBe(2);

    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.getByParent('settings')).toHaveLength(0);
    expect(registry.getByParent('projects')).toHaveLength(0);
  });

  it('should return empty array for parent with no sections', () => {
    const result = registry.getByParent('nonexistent');
    expect(result).toEqual([]);
  });

  it('should return empty array for category with no sections', () => {
    registry.register({
      id: 'section1',
      parentPageId: 'settings',
      name: 'Section 1',
      category: 'system',
      component: () => null,
    });

    const result = registry.getByParentAndCategory('settings', 'nonexistent');
    expect(result).toEqual([]);
  });
});

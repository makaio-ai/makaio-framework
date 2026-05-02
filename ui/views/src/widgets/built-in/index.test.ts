import { beforeEach, describe, expect, it } from 'vitest';
import { WidgetRegistry } from '@makaio/ui-kernel';
import { frameworkOpenDashboardWidgetDefinition } from './open-dashboard-widget.js';
import { frameworkStatusWidgetDefinition } from './StatusWidget.js';
import { registerFrameworkBuiltInWidgets } from './index.js';

describe('registerFrameworkBuiltInWidgets', () => {
  let registry: WidgetRegistry;

  beforeEach(() => {
    registry = new WidgetRegistry();
  });

  it('registers both framework built-in widgets', () => {
    registerFrameworkBuiltInWidgets(registry);

    expect(registry.has(frameworkStatusWidgetDefinition.id)).toBe(true);
    expect(registry.has(frameworkOpenDashboardWidgetDefinition.id)).toBe(true);
  });

  it('returns a cleanup that unregisters both widgets', () => {
    const cleanup = registerFrameworkBuiltInWidgets(registry);

    cleanup();

    expect(registry.has(frameworkStatusWidgetDefinition.id)).toBe(false);
    expect(registry.has(frameworkOpenDashboardWidgetDefinition.id)).toBe(false);
  });

  it('does not affect other widgets already in the registry when cleaned up', () => {
    const otherDefinition = {
      component: () => null,
      defaultSize: 'medium' as const,
      id: 'host-widget',
      name: 'Host Widget',
      scope: 'global' as const,
      supportedSizes: ['medium' as const],
    };

    registry.register(otherDefinition);
    const cleanup = registerFrameworkBuiltInWidgets(registry);

    cleanup();

    expect(registry.has('host-widget')).toBe(true);
    expect(registry.has(frameworkStatusWidgetDefinition.id)).toBe(false);
    expect(registry.has(frameworkOpenDashboardWidgetDefinition.id)).toBe(false);
  });
});

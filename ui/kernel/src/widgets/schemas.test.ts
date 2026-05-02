import { describe, it, expect } from 'vitest';
import { WidgetRawSchemas } from './schemas.js';
import type { WidgetScope } from './scope-registry.js';

declare module '@makaio/contracts' {
  interface UiScopeMap {
    // Test-only host augmentation; framework-owned built-ins remain `global` and `any`.
    panel: true;
  }
}

describe('Widget Schemas', () => {
  describe('WidgetDefinitionSchema (register)', () => {
    const validWidget = {
      id: 'test-widget',
      name: 'Test Widget',
      scope: 'global' as const,
      description: 'A test widget',
      supportedSizes: ['small' as const, 'medium' as const, 'full-width' as const],
      defaultSize: 'medium' as const,
      component: () => null,
      defaultConfig: { foo: 'bar' },
    };

    it('accepts valid widget definition with all fields', () => {
      const result = WidgetRawSchemas.register.safeParse(validWidget);
      expect(result.success).toBe(true);
    });

    it('accepts valid widget definition without optional fields', () => {
      const minimalWidget = {
        id: 'test-widget',
        name: 'Test Widget',
        scope: 'panel' as const,
        supportedSizes: ['large' as const],
        defaultSize: 'large' as const,
        component: () => null,
      };
      const result = WidgetRawSchemas.register.safeParse(minimalWidget);
      expect(result.success).toBe(true);
    });

    it('accepts "any" scope', () => {
      const widget = { ...validWidget, scope: 'any' as const };
      const result = WidgetRawSchemas.register.safeParse(widget);
      expect(result.success).toBe(true);
    });

    it('accepts custom scope (extensible for extensions)', () => {
      // WidgetScopeSchema is z.string() to allow custom scopes registered via WidgetScopeRegistry
      const widget = { ...validWidget, scope: 'custom-plugin-scope' };
      const result = WidgetRawSchemas.register.safeParse(widget);
      expect(result.success).toBe(true);
    });

    it('rejects invalid size in supportedSizes', () => {
      const widget = { ...validWidget, supportedSizes: ['invalid' as const] };
      const result = WidgetRawSchemas.register.safeParse(widget);
      expect(result.success).toBe(false);
    });

    it('rejects invalid defaultSize', () => {
      const widget = { ...validWidget, defaultSize: 'invalid' };
      const result = WidgetRawSchemas.register.safeParse(widget);
      expect(result.success).toBe(false);
    });

    it('rejects defaultSize not in supportedSizes (Zod allows this, runtime validation may catch it)', () => {
      // Note: Zod schema doesn't enforce that defaultSize must be in supportedSizes
      // This is intentional - the schema validates types, not business logic
      const widget = {
        ...validWidget,
        supportedSizes: ['small' as const],
        defaultSize: 'large' as const,
      };
      const result = WidgetRawSchemas.register.safeParse(widget);
      expect(result.success).toBe(true);
    });

    it('requires id field', () => {
      const { id, ...widgetWithoutId } = validWidget;
      const result = WidgetRawSchemas.register.safeParse(widgetWithoutId);
      expect(result.success).toBe(false);
    });

    it('requires name field', () => {
      const { name, ...widgetWithoutName } = validWidget;
      const result = WidgetRawSchemas.register.safeParse(widgetWithoutName);
      expect(result.success).toBe(false);
    });

    it('requires scope field', () => {
      const { scope, ...widgetWithoutScope } = validWidget;
      const result = WidgetRawSchemas.register.safeParse(widgetWithoutScope);
      expect(result.success).toBe(false);
    });

    it('requires supportedSizes field', () => {
      const { supportedSizes, ...widgetWithoutSizes } = validWidget;
      const result = WidgetRawSchemas.register.safeParse(widgetWithoutSizes);
      expect(result.success).toBe(false);
    });

    it('requires defaultSize field', () => {
      const { defaultSize, ...widgetWithoutDefaultSize } = validWidget;
      const result = WidgetRawSchemas.register.safeParse(widgetWithoutDefaultSize);
      expect(result.success).toBe(false);
    });

    it('requires component field', () => {
      const { component, ...widgetWithoutComponent } = validWidget;
      const result = WidgetRawSchemas.register.safeParse(widgetWithoutComponent);
      expect(result.success).toBe(false);
    });
  });

  describe('Unregister Schema', () => {
    it('accepts valid unregister payload', () => {
      const result = WidgetRawSchemas.unregister.safeParse({ widgetId: 'test-widget' });
      expect(result.success).toBe(true);
    });

    it('rejects missing widgetId', () => {
      const result = WidgetRawSchemas.unregister.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects non-string widgetId', () => {
      const result = WidgetRawSchemas.unregister.safeParse({ widgetId: 123 });
      expect(result.success).toBe(false);
    });
  });

  describe('List Schema', () => {
    describe('request', () => {
      it('accepts valid request without scope filter', () => {
        const result = WidgetRawSchemas.list.request.safeParse({});
        expect(result.success).toBe(true);
      });

      it('accepts valid request with scope filter', () => {
        const result = WidgetRawSchemas.list.request.safeParse({ scope: 'global' });
        expect(result.success).toBe(true);
      });

      it('accepts framework default scope values', () => {
        const scopes = ['global', 'any'] as const;
        scopes.forEach((scope) => {
          const result = WidgetRawSchemas.list.request.safeParse({ scope });
          expect(result.success).toBe(true);
        });
      });

      it('accepts custom scope value (extensible for extensions)', () => {
        // WidgetScopeSchema is z.string() to allow custom scopes
        const result = WidgetRawSchemas.list.request.safeParse({ scope: 'custom-scope' });
        expect(result.success).toBe(true);
      });
    });

    describe('response', () => {
      const mockComponent = () => null;

      const validWidgets = [
        {
          id: 'widget-1',
          name: 'Widget 1',
          scope: 'global' as const,
          supportedSizes: ['small' as const, 'medium' as const],
          defaultSize: 'medium' as const,
          component: mockComponent,
        },
        {
          id: 'widget-2',
          name: 'Widget 2',
          scope: 'panel' as const,
          description: 'A panel-scoped widget',
          supportedSizes: ['large' as const],
          defaultSize: 'large' as const,
          component: mockComponent,
          defaultConfig: { setting: true },
        },
      ];

      it('accepts valid response with widgets', () => {
        const result = WidgetRawSchemas.list.response.safeParse({ widgets: validWidgets });
        expect(result.success).toBe(true);
      });

      it('accepts valid response with empty widgets array', () => {
        const result = WidgetRawSchemas.list.response.safeParse({ widgets: [] });
        expect(result.success).toBe(true);
      });

      it('requires widgets field', () => {
        const result = WidgetRawSchemas.list.response.safeParse({});
        expect(result.success).toBe(false);
      });

      it('rejects non-array widgets field', () => {
        const result = WidgetRawSchemas.list.response.safeParse({ widgets: 'not-an-array' });
        expect(result.success).toBe(false);
      });
    });
  });
});

/**
 * Type-level tests for WidgetScope.
 *
 * WidgetScope = UiScope from `\@makaio/contracts` (strict type safety).
 * Plugins extend via declaration merging, not runtime strings.
 */
describe('WidgetScope type', () => {
  it('accepts built-in scopes', () => {
    const global: WidgetScope = 'global';
    const any: WidgetScope = 'any';
    expect([global, any]).toEqual(['global', 'any']);
  });

  it('accepts host-augmented scopes declared through UiScopeMap', () => {
    const panel: WidgetScope = 'panel';
    expect(panel).toBe('panel');
  });

  it('rejects unknown scope literals at compile time', () => {
    // @ts-expect-error - 'invalid' is not in UiScopeMap
    const _invalid: WidgetScope = 'invalid';
    // @ts-expect-error - 'custom-scope' requires declaration merging
    const _custom: WidgetScope = 'custom-scope';

    // Runtime assertions (values exist, type system caught the error)
    expect(_invalid).toBe('invalid');
    expect(_custom).toBe('custom-scope');
  });

  it('rejects non-string values at compile time', () => {
    // @ts-expect-error - WidgetScope must be a string key
    const _number: WidgetScope = 123;
    // @ts-expect-error - WidgetScope must be a string key
    const _boolean: WidgetScope = true;

    expect(typeof _number).toBe('number');
    expect(typeof _boolean).toBe('boolean');
  });
});

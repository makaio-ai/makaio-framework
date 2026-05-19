import { describe, expect, it } from 'bun:test';
import { deriveTrayLayout } from './tray-layout.js';
import type { WidgetDefinition } from './types.js';

declare module '@makaio/contracts' {
  interface UiScopeMap {
    tray: true;
  }
}

/**
 * Minimal tray-scoped widget factory.
 * @param id - Unique widget identifier.
 * @param defaultSize - Widget default size (affects `h` in the derived layout).
 * @returns A minimal WidgetDefinition with scope 'tray'.
 */
function makeTrayWidget(id: string, defaultSize: WidgetDefinition['defaultSize'] = 'small'): WidgetDefinition {
  return {
    component: () => null,
    defaultSize,
    id,
    name: id,
    scope: 'tray',
    supportedSizes: [defaultSize],
  };
}

describe('deriveTrayLayout', () => {
  describe('locked widgets pinned first', () => {
    it('places locked widgets before non-locked widgets', () => {
      const widgets = [makeTrayWidget('widget-a'), makeTrayWidget('widget-b'), makeTrayWidget('locked-1')];
      const { placements } = deriveTrayLayout(widgets, ['locked-1']);

      expect(placements[0].widgetId).toBe('locked-1');
      expect(placements[0].locked).toBe(true);
      expect(placements.find((p) => p.widgetId === 'widget-a')?.locked).toBeUndefined();
      expect(placements.find((p) => p.widgetId === 'widget-b')?.locked).toBeUndefined();
    });

    it('preserves the order of lockedWidgetIds', () => {
      const widgets = [makeTrayWidget('lock-z'), makeTrayWidget('lock-a'), makeTrayWidget('lock-m')];
      const { placements } = deriveTrayLayout(widgets, ['lock-z', 'lock-a', 'lock-m']);

      expect(placements[0].widgetId).toBe('lock-z');
      expect(placements[1].widgetId).toBe('lock-a');
      expect(placements[2].widgetId).toBe('lock-m');
    });

    it('skips a locked widget ID that is not registered in the tray scope', () => {
      const widgets = [makeTrayWidget('registered')];
      const { placements } = deriveTrayLayout(widgets, ['ghost-widget', 'registered']);

      expect(placements).toHaveLength(1);
      expect(placements[0].widgetId).toBe('registered');
    });

    it('deduplicates locked IDs', () => {
      const widgets = [makeTrayWidget('dup')];
      const { placements } = deriveTrayLayout(widgets, ['dup', 'dup']);

      expect(placements).toHaveLength(1);
    });
  });

  describe('non-locked widgets follow in registration order', () => {
    it('non-locked widgets appear after locked ones in registration order', () => {
      const widgets = [makeTrayWidget('first'), makeTrayWidget('second'), makeTrayWidget('locked')];
      const { placements } = deriveTrayLayout(widgets, ['locked']);

      expect(placements[0].widgetId).toBe('locked');
      expect(placements[1].widgetId).toBe('first');
      expect(placements[2].widgetId).toBe('second');
    });
  });

  describe('all placements have w: 2', () => {
    it('sets w to 2 for every placement regardless of widget size', () => {
      const widgets = [makeTrayWidget('sm', 'small'), makeTrayWidget('lg', 'large')];
      const { placements } = deriveTrayLayout(widgets);

      for (const placement of placements) {
        expect(placement.w).toBe(2);
      }
    });
  });

  describe('h derived from trayDefaultSize or defaultSize via TRAY_SIZE_MAPPING', () => {
    it('maps small to h: 1', () => {
      const { placements } = deriveTrayLayout([makeTrayWidget('sm', 'small')]);
      expect(placements[0].h).toBe(1);
    });

    it('maps medium to h: 2', () => {
      const { placements } = deriveTrayLayout([makeTrayWidget('md', 'medium')]);
      expect(placements[0].h).toBe(2);
    });

    it('maps large to h: 3', () => {
      const { placements } = deriveTrayLayout([makeTrayWidget('lg', 'large')]);
      expect(placements[0].h).toBe(3);
    });

    it('maps full-width to h: 4', () => {
      const { placements } = deriveTrayLayout([makeTrayWidget('fw', 'full-width')]);
      expect(placements[0].h).toBe(4);
    });
  });

  describe('trayDefaultSize overrides defaultSize for h calculation', () => {
    it('uses trayDefaultSize when provided, ignoring defaultSize', () => {
      const widget: WidgetDefinition = { ...makeTrayWidget('status', 'large'), trayDefaultSize: 'small' };
      const { placements } = deriveTrayLayout([widget]);

      expect(placements[0].h).toBe(1);
      expect(placements[0].size).toBe('small');
    });

    it('falls back to defaultSize when trayDefaultSize is absent', () => {
      const { placements } = deriveTrayLayout([makeTrayWidget('regular', 'medium')]);

      expect(placements[0].h).toBe(2);
      expect(placements[0].size).toBe('medium');
    });

    it('applies trayDefaultSize to locked placements as well', () => {
      const widget: WidgetDefinition = { ...makeTrayWidget('locked-status', 'large'), trayDefaultSize: 'small' };
      const { placements } = deriveTrayLayout([widget], ['locked-status']);

      expect(placements[0].locked).toBe(true);
      expect(placements[0].h).toBe(1);
      expect(placements[0].size).toBe('small');
    });
  });

  describe('scope filtering', () => {
    it('excludes non-tray widgets', () => {
      const widgets = [makeTrayWidget('tray-one'), { ...makeTrayWidget('global-one'), scope: 'global' as const }];
      const { placements } = deriveTrayLayout(widgets);

      expect(placements).toHaveLength(1);
      expect(placements[0].widgetId).toBe('tray-one');
    });
  });

  describe('instanceId collision resistance', () => {
    it('produces distinct instanceIds for locked vs non-locked widgets with overlapping names', () => {
      const widgets = [makeTrayWidget('foo'), makeTrayWidget('locked-foo')];
      const { placements } = deriveTrayLayout(widgets, ['foo']);

      const lockedPlacement = placements.find((p) => p.widgetId === 'foo');
      const nonLockedPlacement = placements.find((p) => p.widgetId === 'locked-foo');

      expect(lockedPlacement).toBeDefined();
      expect(nonLockedPlacement).toBeDefined();
      expect(lockedPlacement!.instanceId).toBe('tray:locked:foo');
      expect(nonLockedPlacement!.instanceId).toBe('tray:item:locked-foo');
      expect(lockedPlacement!.instanceId).not.toBe(nonLockedPlacement!.instanceId);
    });
  });

  describe('row accumulation', () => {
    it('stacks placements vertically with correct row offsets', () => {
      const widgets = [makeTrayWidget('a', 'small'), makeTrayWidget('b', 'medium'), makeTrayWidget('c', 'large')];
      const { placements } = deriveTrayLayout(widgets);

      expect(placements[0].row).toBe(1);
      expect(placements[1].row).toBe(2); // 1 + h:1
      expect(placements[2].row).toBe(4); // 2 + h:2
    });
  });

  describe('version', () => {
    it('always returns version 1', () => {
      expect(deriveTrayLayout([]).version).toBe(1);
    });
  });

  describe('empty input', () => {
    it('returns empty placements for no widgets', () => {
      const { placements } = deriveTrayLayout([]);
      expect(placements).toHaveLength(0);
    });

    it('returns empty placements when no widgets match tray scope', () => {
      const widgets = [{ ...makeTrayWidget('global'), scope: 'global' as const }];
      const { placements } = deriveTrayLayout(widgets);
      expect(placements).toHaveLength(0);
    });

    it('excludes widgets scoped to "any" — tray surface is strictly tray-scoped', () => {
      const widgets = [makeTrayWidget('tray-one'), { ...makeTrayWidget('any-one'), scope: 'any' as const }];
      const { placements } = deriveTrayLayout(widgets);
      expect(placements).toHaveLength(1);
      expect(placements[0].widgetId).toBe('tray-one');
    });
  });
});

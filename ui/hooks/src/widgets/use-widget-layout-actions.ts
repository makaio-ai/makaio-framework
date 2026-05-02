import { useCallback } from 'react';
import { PreferencesSubjects, type PreferenceKey } from '@makaio/services-core/preferences';
import type { WidgetLayout } from '@makaio/ui-kernel';
import { useBus } from '../bus/bus-provider.js';

const LAYOUT_CATEGORY = 'widget-layout';

/**
 * Persist or reset widget layouts in preferences.
 * @returns Layout mutation helpers bound to the current bus instance.
 */
export function useWidgetLayoutActions() {
  const bus = useBus();

  const saveLayout = useCallback(
    async (key: PreferenceKey, layout: WidgetLayout) => {
      await bus.request(PreferencesSubjects.set, {
        category: LAYOUT_CATEGORY,
        key,
        value: layout,
      });
    },
    [bus],
  );

  const resetLayout = useCallback(
    async (key: PreferenceKey) => {
      await bus.request(PreferencesSubjects.delete, {
        category: LAYOUT_CATEGORY,
        key,
      });
    },
    [bus],
  );

  return { saveLayout, resetLayout };
}

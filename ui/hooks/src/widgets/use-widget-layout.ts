import { useCallback, useEffect, useState } from 'react';
import { PreferencesSubjects, type PreferenceKey } from '@makaio/services-core/preferences';
import { isWidgetLayout, type WidgetLayout } from '@makaio/ui-kernel';
import { useBus } from '../bus/bus-provider.js';

const LAYOUT_CATEGORY = 'widget-layout';

/**
 * Load a widget layout preference and expose its fetch state.
 * @param preferenceKey - Preference key that identifies the layout.
 * @returns The current layout value plus loading, error, and refresh state.
 */
export function useWidgetLayout(preferenceKey: PreferenceKey) {
  const bus = useBus();
  const [layout, setLayout] = useState<WidgetLayout | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchLayout = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { value } = await bus.request(PreferencesSubjects.get, {
        category: LAYOUT_CATEGORY,
        key: preferenceKey,
      });

      setLayout(isWidgetLayout(value) ? value : null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError : new Error('Failed to load layout'));
      setLayout(null);
    } finally {
      setIsLoading(false);
    }
  }, [bus, preferenceKey]);

  useEffect(() => {
    void fetchLayout();
  }, [fetchLayout]);

  return { layout, isLoading, error, refresh: fetchLayout };
}

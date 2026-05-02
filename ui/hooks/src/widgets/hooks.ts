import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { UiScope } from '@makaio/contracts';
import { PreferencesSubjects } from '@makaio/services-core/preferences';
import { widgetRegistry, subscribeToWidgetEvents } from '@makaio/ui-kernel';
import type { WidgetDefinition, WidgetScope } from '@makaio/ui-kernel';
import { useBus } from '../bus/bus-provider.js';

/**
 * Type guard for plain objects — rejects arrays, class instances, null, and
 * all non-object primitives. Used to safely spread persisted preference values
 * into config without corrupting state with unexpected shapes (e.g. an array
 * stored under the same key from an old schema version).
 * @param value - Value to test.
 * @returns `true` when `value` is an object-literal value with `Object.prototype`.
 *   Note: `Object.create(null)` objects are rejected; this is acceptable since
 *   JSON-parsed objects always have `Object.prototype`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

const EMPTY_BUILT_INS: readonly WidgetDefinition[] = Object.freeze([]);

export interface UseWidgetsOptions {
  builtIns?: readonly WidgetDefinition[];
  scope?: WidgetScope;
  includeAny?: boolean;
}

export interface UseWidgetsResult {
  builtInWidgets: readonly WidgetDefinition[];
  loading: boolean;
  widgets: ReadonlyArray<WidgetDefinition> | undefined;
}

/**
 * Register built-in widgets once and subscribe to runtime widget registrations.
 * @param options - Built-in registration and scope-filter options.
 * @returns Registered built-ins plus the current widget list for the requested scope.
 */
export function useWidgets(options: UseWidgetsOptions = {}): UseWidgetsResult {
  const { builtIns = EMPTY_BUILT_INS, scope, includeAny = true } = options;
  const bus = useBus();
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    // widgetRegistry.register is idempotent (returns false on duplicate, no throw),
    // so re-firing this effect on a non-memoized `builtIns` is wasteful but safe.
    widgetRegistry.registerAll(builtIns);
  }, [builtIns]);

  useEffect(() => {
    const cleanup = subscribeToWidgetEvents(bus);
    setInitialized(true);

    return () => {
      cleanup();
      setInitialized(false);
    };
  }, [bus]);

  const subscribe = useCallback((callback: () => void) => widgetRegistry.subscribe(callback), []);
  const getSnapshot = useCallback(() => widgetRegistry.getAll(), []);
  const allWidgets = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const filteredWidgets = useMemo(() => {
    if (!scope) {
      return allWidgets;
    }

    return widgetRegistry.getByScope(scope, includeAny);
  }, [allWidgets, includeAny, scope]);

  return {
    builtInWidgets: builtIns,
    loading: !initialized,
    widgets: initialized ? filteredWidgets : undefined,
  };
}

export interface UseWidgetRegistryOptions {
  scope?: WidgetScope;
  includeAny?: boolean;
}

/**
 * Read registered widgets reactively from the shared widget registry.
 * @param options - Optional scope filter and include-any behavior.
 * @returns Widget definitions matching the requested scope.
 */
export function useWidgetRegistry(options: UseWidgetRegistryOptions = {}): ReadonlyArray<WidgetDefinition> {
  const { scope, includeAny = true } = options;
  const subscribe = useCallback((callback: () => void) => widgetRegistry.subscribe(callback), []);
  const getSnapshot = useCallback(() => widgetRegistry.getAll(), []);
  const allWidgets = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => {
    if (!scope) {
      return allWidgets;
    }

    return widgetRegistry.getByScope(scope, includeAny);
  }, [allWidgets, includeAny, scope]);
}

export interface UseWidgetConfigOptions<TConfig extends Record<string, unknown>> {
  paneId: string;
  widgetId: string;
  context: WidgetLayoutContext;
  surface: 'ui' | 'app';
  defaultConfig: TConfig;
}

export interface UseWidgetConfigResult<TConfig extends Record<string, unknown>> {
  config: TConfig;
  updateConfig: (partial: Partial<TConfig>) => void;
}

export interface WidgetLayoutContext {
  readonly scope: UiScope;
  readonly contextId?: string | null;
}

/**
 * Build a stable context identity from scope and optional context ID.
 * @param context - Generic UI context identity for persistence.
 * @returns Preference-suitable context key.
 */
function buildWidgetContextKey(context: WidgetLayoutContext): string {
  return context.contextId ? `${context.scope}:${context.contextId}` : context.scope;
}

/**
 * Load and persist widget instance configuration through preferences.
 * @param options - Widget identity plus default configuration.
 * @returns Current widget config and a partial-update helper.
 */
export function useWidgetConfig<TConfig extends Record<string, unknown>>(
  options: UseWidgetConfigOptions<TConfig>,
): UseWidgetConfigResult<TConfig> {
  const { paneId, widgetId, context, surface, defaultConfig } = options;
  const bus = useBus();
  const [config, setConfig] = useState<TConfig>(defaultConfig);
  const loadRunIdRef = useRef(0);
  const contextKey = useMemo(() => buildWidgetContextKey(context), [context.contextId, context.scope]);

  const pref = useMemo(
    () => ({
      category: `widget-config:${paneId}:${widgetId}`,
      key: {
        scope: contextKey,
        surface,
      },
    }),
    [contextKey, paneId, surface, widgetId],
  );
  // Use structuredClone so the reset path preserves richer object shapes while
  // still breaking reference equality with the caller-owned default config.
  const defaultConfigSnapshot = useMemo(() => structuredClone(defaultConfig), [defaultConfig]);

  useEffect(() => {
    const currentRunId = ++loadRunIdRef.current;
    const isCurrentRun = (): boolean => loadRunIdRef.current === currentRunId;
    setConfig(defaultConfigSnapshot);

    const load = async (): Promise<void> => {
      try {
        const { value } = await bus.request(PreferencesSubjects.get, {
          category: pref.category,
          key: pref.key,
        });

        if (!isCurrentRun()) {
          return;
        }

        if (isPlainObject(value)) {
          setConfig((current) => ({
            ...current,
            ...(value as Partial<TConfig>),
          }));
        }
      } catch {
        // Preferences are optional here; keep defaults when unavailable.
      }
    };

    void load();

    return () => {
      ++loadRunIdRef.current;
    };
  }, [bus, defaultConfigSnapshot, pref]);

  // Persistence is best-effort: errors are swallowed (see catch below), and
  // rapid updates can theoretically race on storage writes. In-memory state
  // always reflects the latest setConfig; storage consistency on rapid
  // successive updates is a known trade-off. If persistence becomes
  // load-bearing, serialize via a promise chain.
  const persistConfig = useCallback(
    async (nextConfig: TConfig) => {
      try {
        await bus.request(PreferencesSubjects.set, {
          category: pref.category,
          key: pref.key,
          value: nextConfig,
        });
      } catch {
        // Ignore persistence errors; the widget should remain interactive.
      }
    },
    [bus, pref],
  );

  const updateConfig = useCallback(
    (partial: Partial<TConfig>) => {
      setConfig((current) => {
        const nextConfig = { ...current, ...partial };
        void persistConfig(nextConfig);
        return nextConfig;
      });
    },
    [persistConfig],
  );

  return { config, updateConfig };
}

/**
 * Tray surface root component.
 *
 * Renders the non-responsive 2-column widget canvas driven by the derived
 * tray layout. This component is mounted when the renderer SPA is loaded with
 * `?surface=tray` — it does **not** require `WorkspaceApp` or the host
 * extension loader.
 *
 * ## Bootstrap contract
 *
 * `TrayView` calls `registerFrameworkBuiltInWidgets` from a mount effect and
 * returns the cleanup on unmount. Because the registration runs after the
 * initial render, the first paint shows an empty canvas; the `widgetRegistry`
 * subscription in `useTrayLayout` then triggers a re-render with the
 * framework-owned tray widgets (status + open-dashboard) on the next frame.
 *
 * ## Layout
 *
 * A fixed 2-column non-responsive grid with `rowHeight: 60` and `margin: [8, 8]`
 * is used so the canvas fits within the 480 × 500 px popover window. The
 * `gridConfig.width` accounts for the 8 px horizontal padding on each side
 * applied by the canvas in fixed mode (480 - 16 = 464 px).
 * @packageDocumentation
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { WidgetCanvas } from '../widget-canvas/WidgetCanvas.js';
import {
  widgetRegistry,
  getRegisteredExtensionBrowserFactory,
  unregisterExtensionBrowserFactory,
  resolveExtensionBrowserFactory,
  runCleanupsInReverse,
  createRuntimeReadyWaiter,
  TRAY_CELL_MARGIN,
  TRAY_GRID_COLS,
  TRAY_GRID_WIDTH_PX,
  TRAY_ROW_HEIGHT_PX,
} from '@makaio/ui-kernel';
import type { WidgetLayout, ExtensionBrowserContribution, ExtensionBrowserFactory } from '@makaio/ui-kernel';
import { FRAMEWORK_TRAY_LOCKED_WIDGET_IDS, registerFrameworkBuiltInWidgets } from '../widgets/built-in/index.js';
import { useBus, useWidgets, loadExtensionBrowserContributions, useTrayLayout } from '@makaio/ui-hooks';
import type { WidgetGridConfig } from '../widget-canvas/WidgetGrid.js';
import styles from './tray-view.module.scss';
import { registerTrayExtensionUI } from './register-tray-extension-ui.js';

/** Fixed grid configuration for the tray canvas — non-responsive, 2 columns. */
const TRAY_GRID_CONFIG: WidgetGridConfig = {
  responsive: false,
  cols: TRAY_GRID_COLS,
  rowHeight: TRAY_ROW_HEIGHT_PX,
  margin: TRAY_CELL_MARGIN,
  width: TRAY_GRID_WIDTH_PX,
};

/** No-op layout saver — the tray layout is registry-derived, not persisted. */
const noopSaveLayout = (): Promise<void> => Promise.resolve();

/**
 * Tray surface root.
 *
 * Registers framework built-ins on mount, derives the tray layout from the
 * widget registry, and renders a fixed 2-column `WidgetCanvas`.
 * @returns Tray canvas populated with tray-scoped widgets.
 */
export function TrayView(): JSX.Element {
  const bus = useBus();
  const extensionLoadRunIdRef = useRef(0);
  const [extensionsLoading, setExtensionsLoading] = useState(false);

  // Register framework built-ins once on mount. The cleanup unregisters them
  // on unmount so re-mounting (e.g. Vite HMR) stays idempotent.
  useEffect(() => {
    return registerFrameworkBuiltInWidgets(widgetRegistry);
  }, []);

  // Load browser contributions so tray-scoped widgets declared by extensions
  // are available on the tray surface, not just on the main dashboard shell.
  useEffect(() => {
    const currentRunId = ++extensionLoadRunIdRef.current;
    const isCurrentRun = (): boolean => extensionLoadRunIdRef.current === currentRunId;
    const cleanups: Array<() => void> = [];
    setExtensionsLoading(true);

    const loadExtensions = async (): Promise<void> => {
      try {
        const result = await loadExtensionBrowserContributions<
          ExtensionBrowserContribution,
          { bus: typeof bus },
          ExtensionBrowserFactory
        >({
          bus,
          getRegisteredFactory: getRegisteredExtensionBrowserFactory,
          isCurrentRun,
          registerExtensionUI: registerTrayExtensionUI,
          resolveFactory: resolveExtensionBrowserFactory,
          unregisterFactory: unregisterExtensionBrowserFactory,
          waitForRuntimeReady: createRuntimeReadyWaiter,
        });

        if (!isCurrentRun()) {
          runCleanupsInReverse(result.cleanups, '[TrayView] stale extension load');
          return;
        }

        cleanups.push(...result.cleanups);

        if (result.errorMessage) {
          console.warn(`[TrayView] ${result.errorMessage}`);
        }
      } catch (error) {
        if (isCurrentRun()) {
          console.error('[TrayView] Failed to load browser contributions for the tray surface', error);
        }
      } finally {
        if (isCurrentRun()) {
          setExtensionsLoading(false);
        }
      }
    };

    void loadExtensions();

    return () => {
      ++extensionLoadRunIdRef.current;
      runCleanupsInReverse(cleanups, '[TrayView]');
    };
  }, [bus]);

  // Subscribe to widget bus events and get all registered tray-scoped widgets.
  // `useWidgets` with no builtIns param here — built-ins are registered via
  // `registerFrameworkBuiltInWidgets` above, not through `useWidgets`.
  const { widgets, loading: widgetsLoading } = useWidgets({ scope: 'tray', includeAny: false });

  const layout: WidgetLayout = useTrayLayout(FRAMEWORK_TRAY_LOCKED_WIDGET_IDS);

  // Stable empty array fallback so WidgetCanvas never receives undefined.
  const resolvedWidgets = useMemo(() => widgets ?? [], [widgets]);

  return (
    <div className={styles.root} data-component="TrayView">
      <div className={styles.canvas}>
        <WidgetCanvas
          gridConfig={TRAY_GRID_CONFIG}
          isEditing={false}
          isLoading={widgetsLoading}
          onSaveLayout={noopSaveLayout}
          rowHeight={TRAY_ROW_HEIGHT_PX}
          savedLayout={layout}
          widgets={resolvedWidgets}
        />
      </div>
      {extensionsLoading ? <div className={styles.loadingState}>Loading extension widgets…</div> : null}
    </div>
  );
}

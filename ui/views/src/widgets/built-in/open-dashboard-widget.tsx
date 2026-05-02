import { useEffect, useRef, useState, type JSX } from 'react';
import { HostSubjects } from '@makaio/contracts';
import { useOptionalBus } from '@makaio/ui-hooks';
import type { WidgetDefinition, WidgetProps } from '@makaio/ui-kernel';
import styles from './open-dashboard-widget.module.scss';

/**
 * Calls the `window.openDashboard` RPC to focus or create the main dashboard
 * window. Disables itself while the request is in-flight to prevent duplicate
 * calls, and when no bus context is available.
 *
 * The `WidgetProps` parameter satisfies the `ComponentType<WidgetProps>` contract
 * required by `WidgetDefinition.component`. This widget does not use size or config.
 * @param _props - Standard widget props required by the `ComponentType<WidgetProps>` contract; unused by this widget.
 * @returns A single button that opens the dashboard window.
 */
function OpenDashboardWidget(_props: WidgetProps): JSX.Element {
  const bus = useOptionalBus();
  const [pending, setPending] = useState(false);
  const inFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleClick = async (): Promise<void> => {
    // `pending` only disables the button after React commits. Keep a
    // synchronous ref guard so rapid double-clicks cannot race the RPC.
    if (!bus || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setPending(true);
    try {
      // `windowId: null` is an allowed response shape — the host reports
      // that it could not create or focus the window. Throw so the existing
      // catch branch logs the failure and the click doesn't silently no-op.
      const { windowId } = await bus.request(HostSubjects.window.openDashboard, {});
      if (windowId === null) {
        throw new Error('Dashboard window could not be opened or focused.');
      }
      if (!isMountedRef.current) {
        return;
      }
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      console.error('[OpenDashboardWidget] Failed to open dashboard:', error);
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) {
        setPending(false);
      }
    }
  };

  const isDisabled = !bus || pending;

  return (
    <div className={styles.widget} data-component="OpenDashboardWidget">
      <button className={styles.button} disabled={isDisabled} onClick={() => void handleClick()} type="button">
        Open Dashboard ↗
      </button>
    </div>
  );
}

/**
 * Built-in tray widget that provides a single-click entry point to the
 * dashboard window.
 *
 * Scoped exclusively to `'tray'`; renders at `'small'` size only. Only one
 * instance is allowed — the tray layout locks it at the top via
 * `FRAMEWORK_TRAY_LOCKED_WIDGET_IDS`.
 */
export const frameworkOpenDashboardWidgetDefinition: WidgetDefinition = {
  allowMultiple: false,
  component: OpenDashboardWidget,
  defaultSize: 'small',
  description: 'Opens the main Makaio dashboard window.',
  id: 'framework-open-dashboard',
  name: 'Open Dashboard',
  scope: ['tray'],
  supportedSizes: ['small'],
};

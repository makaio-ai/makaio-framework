import { useCallback, useMemo, useState, type JSX } from 'react';
import type { PreferenceKey } from '@makaio/services-core/preferences';
import { BusProvider, useWidgets, useWidgetLayout, useWidgetLayoutActions } from '@makaio/ui-hooks';
import type { ShellProps, WidgetDefinition, WidgetLayout, WidgetPlacement } from '@makaio/ui-kernel';
import { WidgetCanvas } from '../widget-canvas/WidgetCanvas.js';
import { SIZE_MAPPING } from '../widget-canvas/WidgetGrid.js';
import { frameworkStatusWidgetDefinition } from '../widgets/built-in/StatusWidget.js';
import { BusStatusIndicator } from './BusStatusIndicator.js';
import styles from './FrameworkShell.module.scss';

/** Stable fallback widget list used before the registry has initialised. */
const FALLBACK_WIDGETS: ReadonlyArray<WidgetDefinition> = Object.freeze([frameworkStatusWidgetDefinition]);

const FRAMEWORK_DASHBOARD_KEY: PreferenceKey = {
  context: 'framework-dashboard',
  scope: 'global',
  surface: 'app',
};

/**
 * Build a default layout that places all available widgets in a vertical stack.
 *
 * Called only when no saved layout exists (first launch or cleared preferences).
 * Producing the same output for the same widget list keeps it stable as a
 * `useMemo` dependency.
 * @param widgets - All registered widgets for the global scope.
 * @returns A version-1 layout with one placement per widget, stacked vertically.
 */
function buildDefaultLayout(widgets: ReadonlyArray<WidgetDefinition>): WidgetLayout {
  const placements: WidgetPlacement[] = [];
  let currentRow = 1;

  for (const widget of widgets) {
    const size = widget.defaultSize;
    const dimensions = SIZE_MAPPING[size] ?? SIZE_MAPPING.medium;
    placements.push({
      col: 1,
      instanceId: `default-${widget.id}`,
      row: currentRow,
      size,
      widgetId: widget.id,
    });
    currentRow += dimensions.h;
  }

  return { version: 1, placements };
}

/**
 * Minimal framework-owned shell shown when no host shell is available.
 * @param props - Shell props supplied by the extension loader.
 * @returns Framework dashboard chrome with status widgets.
 */
export function FrameworkShell(props: ShellProps): JSX.Element {
  return (
    <BusProvider bus={props.bus}>
      <FrameworkShellContent />
    </BusProvider>
  );
}

/**
 * Framework-owned dashboard content used by the fallback shell.
 * @returns Widget dashboard with runtime status chrome.
 */
function FrameworkShellContent(): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const { widgets, loading: widgetsLoading } = useWidgets({
    builtIns: [frameworkStatusWidgetDefinition],
    scope: 'global',
  });
  const { layout, isLoading, error } = useWidgetLayout(FRAMEWORK_DASHBOARD_KEY);
  const { saveLayout } = useWidgetLayoutActions();

  const toggleEdit = useCallback(() => {
    setIsEditing((prev) => !prev);
  }, []);

  const resolvedWidgets = widgets ?? FALLBACK_WIDGETS;
  const defaultLayout = useMemo(() => buildDefaultLayout(resolvedWidgets), [resolvedWidgets]);

  return (
    <div className={styles.shell} data-component="FrameworkShell">
      <header className={styles.header}>
        <div className={styles.branding}>
          <strong className={styles.brandName}>Makaio</strong>
          <span className={styles.brandSubtitle}>Framework shell</span>
        </div>
        <div className={styles.headerActions}>
          <button
            aria-pressed={isEditing}
            className={`${styles.editButton} ${isEditing ? styles.editButtonActive : ''}`}
            onClick={toggleEdit}
            title={isEditing ? 'Done editing' : 'Edit layout'}
            type="button"
          >
            <EditIcon />
            {isEditing ? 'Done' : 'Edit'}
          </button>
          <BusStatusIndicator />
        </div>
      </header>

      <main className={styles.main}>
        <WidgetCanvas
          error={error}
          isEditing={isEditing}
          isLoading={isLoading || widgetsLoading}
          onSaveLayout={(nextLayout) => saveLayout(FRAMEWORK_DASHBOARD_KEY, nextLayout)}
          onToggleEdit={toggleEdit}
          savedLayout={layout ?? defaultLayout}
          widgets={resolvedWidgets}
        />
      </main>
    </div>
  );
}

/**
 * Inline SVG pencil icon for the edit button (no external dependency).
 * @returns Pencil icon SVG element.
 */
function EditIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={14}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={14}
    >
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

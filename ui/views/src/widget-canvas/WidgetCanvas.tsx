/* eslint max-lines-per-function: ["error", { max: 500 }] */
import { useEffect, useMemo, useRef, useState, type FC, type RefObject, type JSX } from 'react';
import { getWidgetDragData } from './drag-payload.js';
import { WidgetGrid, SIZE_MAPPING } from './WidgetGrid.js';
import { WidgetPalette } from './WidgetPalette.js';
import styles from './WidgetCanvas.module.scss';
import type { WidgetCanvasProps } from './types.js';
import { useWindowContext } from '@makaio/ui-hooks';
import type { WidgetLayout, WidgetPlacement } from '@makaio/ui-kernel';

const createEmptyLayout = (): WidgetLayout => ({ version: 1, placements: [] });

interface WidgetCanvasStateApi {
  activeIsEditing: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  draggingWidgetId: string | null;
  layout: WidgetLayout;
  setDraggingWidgetId: (widgetId: string | null) => void;
  handleDrop: (_layout: unknown, item: { x: number; y: number }, event: DragEvent) => void;
  handleLayoutChange: (nextLayout: WidgetLayout) => void;
  handleRemoveWidget: (instanceId: string) => void;
  handleToggleEdit: () => void;
}

/**
 * Register the unload prompt while a dashboard layout has unsaved changes.
 * @param hasChanges - Whether the current layout differs from persisted state.
 */
function usePendingLayoutWarning(hasChanges: boolean): void {
  useEffect(() => {
    if (!hasChanges) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent): string => {
      event.preventDefault();
      event.returnValue = '';
      return '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasChanges]);
}

/**
 * Persist dashboard changes when edit mode closes.
 * @param activeIsEditing - Whether edit mode is currently active.
 * @param hasChanges - Whether there are unsaved changes.
 * @param layout - Current layout to persist.
 * @param editGenerationRef - Ref tracking the edit generation for stale-save detection.
 * @param onSaveLayoutRef - Ref to the latest save handler.
 * @param previousIsEditingRef - Ref tracking the previous edit-mode value.
 * @param setDraggingWidgetId - Setter clearing drag state after save.
 * @param setHasChanges - Setter clearing the dirty flag after save.
 */
function useAutoSaveOnEditExit(
  activeIsEditing: boolean,
  hasChanges: boolean,
  layout: WidgetLayout,
  editGenerationRef: RefObject<number>,
  onSaveLayoutRef: RefObject<(layout: WidgetLayout) => Promise<void>>,
  previousIsEditingRef: RefObject<boolean>,
  setDraggingWidgetId: (widgetId: string | null) => void,
  setHasChanges: (hasChanges: boolean) => void,
): void {
  useEffect(() => {
    const wasEditing = previousIsEditingRef.current;
    previousIsEditingRef.current = activeIsEditing;

    if (wasEditing && !activeIsEditing && hasChanges) {
      // Capture the edit generation at save-start so the resolve callback
      // only clears dirty state when no newer edits arrived in the interim.
      const savedGeneration = editGenerationRef.current;
      void onSaveLayoutRef
        .current(layout)
        .then(() => {
          if (editGenerationRef.current === savedGeneration) {
            setHasChanges(false);
          }
          setDraggingWidgetId(null);
        })
        .catch((nextError) => {
          console.error('Failed to save layout:', nextError);
        });
    }
  }, [
    activeIsEditing,
    editGenerationRef,
    hasChanges,
    layout,
    onSaveLayoutRef,
    previousIsEditingRef,
    setDraggingWidgetId,
    setHasChanges,
  ]);
}

/**
 * Manage the editable widget dashboard state for the framework shell.
 * @param options - Canvas props relevant to layout state management.
 * @returns State and handlers required by the widget canvas view.
 */
function useWidgetCanvasState(
  options: Pick<
    WidgetCanvasProps,
    'savedLayout' | 'onSaveLayout' | 'widgets' | 'onLayoutChange' | 'isEditing' | 'onToggleEdit'
  >,
): WidgetCanvasStateApi {
  const { savedLayout, onSaveLayout, widgets, onLayoutChange, isEditing, onToggleEdit } = options;
  const [layout, setLayout] = useState<WidgetLayout>(createEmptyLayout());
  const [localIsEditing, setLocalIsEditing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [draggingWidgetId, setDraggingWidgetId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<WidgetLayout>(createEmptyLayout());
  const editGenerationRef = useRef(0);
  const onSaveLayoutRef = useRef(onSaveLayout);
  const previousIsEditingRef = useRef(false);

  const activeIsEditing = isEditing ?? localIsEditing;

  useEffect(() => {
    const nextLayout = savedLayout ?? createEmptyLayout();
    layoutRef.current = nextLayout;
    setLayout(nextLayout);
  }, [savedLayout]);

  useEffect(() => {
    onSaveLayoutRef.current = onSaveLayout;
  }, [onSaveLayout]);

  usePendingLayoutWarning(hasChanges);
  useAutoSaveOnEditExit(
    activeIsEditing,
    hasChanges,
    layout,
    editGenerationRef,
    onSaveLayoutRef,
    previousIsEditingRef,
    setDraggingWidgetId,
    setHasChanges,
  );

  const handleToggleEdit = onToggleEdit ?? (() => setLocalIsEditing((current) => !current));

  const commitLayout = (nextLayout: WidgetLayout): void => {
    layoutRef.current = nextLayout;
    editGenerationRef.current++;
    setLayout(nextLayout);
    setHasChanges(true);
    onLayoutChange?.(nextLayout);
  };

  const handleLayoutChange = (nextLayout: WidgetLayout): void => {
    commitLayout(nextLayout);
  };

  const handleDrop = (_layout: unknown, item: { x: number; y: number }, event: DragEvent): void => {
    const widgetId = getWidgetDragData(event.dataTransfer)?.widgetId ?? draggingWidgetId;
    if (!widgetId) {
      return;
    }

    const definition = widgets.find((widget) => widget.id === widgetId);
    if (!definition) {
      return;
    }

    const placement: WidgetPlacement = {
      col: item.x + 1,
      config: definition.defaultConfig,
      instanceId: self.crypto.randomUUID(),
      row: item.y + 1,
      size: definition.defaultSize,
      widgetId,
    };

    commitLayout({
      ...layoutRef.current,
      placements: [...layoutRef.current.placements, placement],
    });
    setDraggingWidgetId(null);
  };

  const handleRemoveWidget = (instanceId: string): void => {
    commitLayout({
      ...layoutRef.current,
      placements: layoutRef.current.placements.filter((placement) => placement.instanceId !== instanceId),
    });
  };

  return {
    activeIsEditing,
    containerRef,
    draggingWidgetId,
    handleDrop,
    handleLayoutChange,
    handleRemoveWidget,
    handleToggleEdit,
    layout,
    setDraggingWidgetId,
  };
}

/**
 * Render the empty dashboard state when no widgets are placed.
 * @returns Empty dashboard prompt.
 */
function WidgetCanvasEmptyState(): JSX.Element {
  return (
    <div className={styles.emptyState} data-component="WidgetCanvasEmptyState">
      <p>Empty Dashboard</p>
      <p>Click the edit button in the header to add widgets.</p>
    </div>
  );
}

/**
 * Render the interactive widget canvas once layout state is available.
 * @param props - Canvas state and view props.
 * @returns Widget grid plus palette when edit mode is active.
 */
function WidgetCanvasContent(
  props: WidgetCanvasStateApi &
    Pick<WidgetCanvasProps, 'gridConfig' | 'rowHeight' | 'uiContext' | 'widgetContext' | 'widgets'> & {
      droppingItem: { h: number; i: string; w: number } | undefined;
    },
): JSX.Element {
  const { activeIsEditing, containerRef, droppingItem, handleDrop, handleLayoutChange, handleRemoveWidget } = props;
  const {
    gridConfig,
    handleToggleEdit,
    layout,
    rowHeight = 80,
    setDraggingWidgetId,
    uiContext,
    widgetContext = {},
    widgets,
  } = props;

  const isNonResponsive = gridConfig?.responsive === false;

  return (
    <div
      className={`${styles.canvas} ${isNonResponsive ? styles.fixed : ''}`}
      data-component="WidgetCanvas"
      ref={containerRef}
    >
      <div className={styles.gridArea}>
        <WidgetGrid
          droppingItem={droppingItem}
          gridConfig={gridConfig}
          isEditing={activeIsEditing}
          layout={layout}
          onDrop={handleDrop}
          onLayoutChange={handleLayoutChange}
          onRemoveWidget={handleRemoveWidget}
          rowHeight={rowHeight}
          uiContext={uiContext}
          widgetContext={widgetContext}
          widgets={widgets}
        />

        {layout.placements.length === 0 && !activeIsEditing ? <WidgetCanvasEmptyState /> : null}
      </div>

      {activeIsEditing ? (
        <WidgetPalette
          containerRef={containerRef}
          currentLayout={layout}
          onClose={handleToggleEdit}
          onDragEnd={() => setDraggingWidgetId(null)}
          onDragStart={(widgetId) => setDraggingWidgetId(widgetId)}
          widgets={widgets}
        />
      ) : null}
    </div>
  );
}

/**
 * Editable widget dashboard that manages layout state and edit-mode lifecycle.
 * @param props - Canvas configuration including widgets, saved layout, and save callback.
 * @returns Widget canvas with grid, palette, and error/loading states.
 */
export const WidgetCanvas: FC<WidgetCanvasProps> = ({
  savedLayout,
  isLoading = false,
  error = null,
  onSaveLayout,
  widgets,
  rowHeight = 80,
  onLayoutChange,
  widgetContext = {},
  uiContext,
  isEditing,
  onToggleEdit,
  gridConfig,
}) => {
  const windowUiContext = useWindowContext((state) => state.uiContext);
  const resolvedUiContext = uiContext ?? windowUiContext;
  const state = useWidgetCanvasState({
    isEditing,
    onLayoutChange,
    onSaveLayout,
    onToggleEdit,
    savedLayout,
    widgets,
  });

  const droppingItem = useMemo(() => {
    if (!state.draggingWidgetId) {
      return undefined;
    }

    const definition = widgets.find((widget) => widget.id === state.draggingWidgetId);
    if (!definition) {
      return undefined;
    }

    const size = SIZE_MAPPING[definition.defaultSize] ?? { h: 2, w: 3 };
    return { h: size.h, i: '__dropping_elem__', w: size.w };
  }, [state.draggingWidgetId, widgets]);

  if (isLoading) {
    return (
      <div className={styles.messageState} data-component="WidgetCanvasLoadingState" role="status">
        Loading dashboard...
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.errorState} data-component="WidgetCanvasErrorState" role="alert">
        Error loading dashboard: {error.message}
      </div>
    );
  }

  return (
    <WidgetCanvasContent
      {...state}
      droppingItem={droppingItem}
      gridConfig={gridConfig}
      rowHeight={rowHeight}
      uiContext={resolvedUiContext}
      widgetContext={widgetContext}
      widgets={widgets}
    />
  );
};

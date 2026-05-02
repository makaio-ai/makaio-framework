/* eslint max-lines-per-function: ["error", { max: 500 }] */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FC,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { setWidgetDragData } from './drag-payload.js';
import styles from './WidgetPalette.module.scss';
import type { WidgetDefinition } from '@makaio/ui-kernel';
import type { WidgetPaletteProps } from './types.js';

const PALETTE_WIDTH = 280;
const PALETTE_PADDING = 16;

const getInitialPosition = (containerRect: DOMRect) => ({
  x: containerRect.width - PALETTE_WIDTH - PALETTE_PADDING,
  y: PALETTE_PADDING,
});

const clampPosition = (position: { x: number; y: number }, containerRect: DOMRect, paletteRect: DOMRect) => ({
  x: Math.max(0, Math.min(position.x, containerRect.width - paletteRect.width)),
  y: Math.max(0, Math.min(position.y, containerRect.height - paletteRect.height)),
});

interface PalettePositionState {
  dragHandleRef: RefObject<HTMLDivElement | null>;
  handleMouseDown: (event: ReactMouseEvent) => void;
  isDragging: boolean;
  paletteRef: RefObject<HTMLDivElement | null>;
  position: { x: number; y: number } | null;
}

/**
 * Track the floating palette position and drag lifecycle.
 * @param containerRef - Canvas container used to clamp palette movement.
 * @returns Position, refs, and mouse handlers for the floating palette.
 */
function usePalettePosition(containerRef?: WidgetPaletteProps['containerRef']): PalettePositionState {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const handleMouseMoveRef = useRef<((event: MouseEvent) => void) | null>(null);
  const handleMouseUpRef = useRef<(() => void) | null>(null);

  // Position stays null until the container ref mounts. This is safe because
  // WidgetPalette is only rendered inside WidgetCanvas which always supplies a
  // mounted containerRef; the null guard in the render path (`if (!position)`)
  // avoids layout before the container's bounding rect is available.
  // No ResizeObserver re-clamp: the palette is a transient editing UI that the
  // user can drag to reposition. Re-clamping on resize would fight user intent.
  useEffect(() => {
    const containerRect = containerRef?.current?.getBoundingClientRect();
    if (containerRect) {
      setPosition(getInitialPosition(containerRect));
    }
  }, [containerRef]);

  useEffect(
    () => () => {
      if (handleMouseMoveRef.current) {
        document.removeEventListener('mousemove', handleMouseMoveRef.current);
      }
      if (handleMouseUpRef.current) {
        document.removeEventListener('mouseup', handleMouseUpRef.current);
      }
    },
    [],
  );

  const handleMouseDown = (event: ReactMouseEvent): void => {
    if (!dragHandleRef.current?.contains(event.target as Node) || !position) {
      return;
    }

    setIsDragging(true);
    const startX = event.clientX - position.x;
    const startY = event.clientY - position.y;

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      const containerRect = containerRef?.current?.getBoundingClientRect();
      if (!containerRect || !paletteRef.current) {
        return;
      }

      const nextPosition = clampPosition(
        { x: moveEvent.clientX - startX, y: moveEvent.clientY - startY },
        containerRect,
        paletteRef.current.getBoundingClientRect(),
      );
      setPosition(nextPosition);
    };

    const handleMouseUp = (): void => {
      setIsDragging(false);
      if (handleMouseMoveRef.current) {
        document.removeEventListener('mousemove', handleMouseMoveRef.current);
      }
      if (handleMouseUpRef.current) {
        document.removeEventListener('mouseup', handleMouseUpRef.current);
      }
      handleMouseMoveRef.current = null;
      handleMouseUpRef.current = null;
    };

    handleMouseMoveRef.current = handleMouseMove;
    handleMouseUpRef.current = handleMouseUp;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };
  return { dragHandleRef, handleMouseDown, isDragging, paletteRef, position };
}

interface WidgetPaletteHeaderProps {
  dragHandleRef: RefObject<HTMLDivElement | null>;
  handleMouseDown: (event: ReactMouseEvent) => void;
  isExpanded: boolean;
  onClose: () => void;
  onToggleExpanded: () => void;
  titleId: string;
}

/**
 * Render the movable palette header controls.
 * @param props - Header state and callbacks.
 * @returns Palette header element.
 */
function WidgetPaletteHeader(props: WidgetPaletteHeaderProps): JSX.Element {
  const { dragHandleRef, handleMouseDown, isExpanded, onClose, onToggleExpanded, titleId } = props;
  return (
    <div className={styles.header} onMouseDown={handleMouseDown}>
      <div className={styles.dragHandle} ref={dragHandleRef}>
        <span aria-hidden="true" className={styles.dragIcon}>
          ⋮⋮
        </span>
        <span className={styles.title} id={titleId}>
          {isExpanded ? 'Widget Palette' : 'Widgets'}
        </span>
      </div>
      <div className={styles.controls}>
        <button
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Minimize palette' : 'Expand palette'}
          className={styles.controlButton}
          onClick={onToggleExpanded}
          type="button"
        >
          {isExpanded ? '−' : '+'}
        </button>
        <button aria-label="Save and exit edit mode" className={styles.controlButton} onClick={onClose} type="button">
          ×
        </button>
      </div>
    </div>
  );
}

interface WidgetPaletteContentProps {
  currentLayout: WidgetPaletteProps['currentLayout'];
  onDragEnd: () => void;
  onDragStart: (widgetId: string) => void;
  widgets: ReadonlyArray<WidgetDefinition>;
}

/**
 * Render the searchable widget list shown inside the palette.
 * @param props - Palette content state and drag handlers.
 * @returns Palette content element.
 */
function WidgetPaletteContent(props: WidgetPaletteContentProps): JSX.Element {
  const { currentLayout, onDragEnd, onDragStart, widgets } = props;
  const [searchTerm, setSearchTerm] = useState('');
  const filteredWidgets = widgets.filter((widget) => widget.name.toLowerCase().includes(searchTerm.toLowerCase()));
  const isWidgetUsed = (widgetId: string): boolean =>
    currentLayout.placements.some((placement) => placement.widgetId === widgetId);
  const isDraggable = (widget: WidgetDefinition): boolean => widget.allowMultiple || !isWidgetUsed(widget.id);

  return (
    <div className={styles.content}>
      <input
        aria-label="Search widgets"
        className={styles.searchInput}
        onChange={(event) => setSearchTerm(event.target.value)}
        placeholder="Search widgets..."
        type="text"
        value={searchTerm}
      />

      <div className={styles.list}>
        {filteredWidgets.map((widget) => {
          const draggable = isDraggable(widget);
          return (
            <div
              className={`${styles.widgetItem} ${!draggable ? styles.disabled : ''}`}
              draggable={draggable}
              key={widget.id}
              onDragEnd={onDragEnd}
              onDragStart={(event) => {
                if (!draggable) {
                  event.preventDefault();
                  return;
                }

                onDragStart(widget.id);
                setWidgetDragData(event.dataTransfer, { widgetId: widget.id });
              }}
            >
              <div className={styles.itemHeader}>
                <div className={styles.itemDot} />
                <span className={styles.itemName}>{widget.name}</span>
              </div>
              {widget.description ? <div className={styles.itemDesc}>{widget.description}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Floating palette panel listing available widgets for drag-drop onto the canvas.
 * @param props - Palette configuration including widget list and drag/close callbacks.
 * @returns Draggable floating palette, or null until the container position is available.
 */
export const WidgetPalette: FC<WidgetPaletteProps> = ({
  widgets,
  currentLayout,
  onDragStart,
  onDragEnd,
  onClose,
  containerRef,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const titleId = useId();
  const { dragHandleRef, handleMouseDown, isDragging, paletteRef, position } = usePalettePosition(containerRef);

  if (!position) {
    return null;
  }

  return (
    <div
      aria-labelledby={titleId}
      className={`${styles.palette} ${isDragging ? styles.dragging : ''} ${!isExpanded ? styles.minimized : ''}`}
      data-component="WidgetPalette"
      ref={paletteRef}
      role="dialog"
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
    >
      <WidgetPaletteHeader
        dragHandleRef={dragHandleRef}
        handleMouseDown={handleMouseDown}
        isExpanded={isExpanded}
        onClose={onClose}
        onToggleExpanded={() => setIsExpanded((current) => !current)}
        titleId={titleId}
      />
      {/* WidgetPaletteContent unmounts on minimize, intentionally resetting searchTerm */}
      {isExpanded ? (
        <WidgetPaletteContent
          currentLayout={currentLayout}
          onDragEnd={onDragEnd}
          onDragStart={onDragStart}
          widgets={widgets}
        />
      ) : null}
    </div>
  );
};

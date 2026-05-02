/**
 * ResizablePanel - Sidebar with drag-to-resize and pin toggle
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type MouseEvent } from 'react';
import { Pin, PinOff, X } from 'lucide-react';
import styles from './ResizablePanel.module.scss';

export type ResizablePanelOrientation = 'horizontal' | 'vertical';

export interface ResizablePanelProps {
  /**
   * Panel title
   */
  title?: string;

  /**
   * Panel content
   */
  children: ReactNode;

  /**
   * Current size in pixels (width for horizontal, height for vertical)
   */
  size: number;

  /**
   * Callback when size changes (during drag)
   */
  onSizeChange: (size: number) => void;

  /**
   * Minimum size
   */
  minSize?: number;

  /**
   * Maximum size
   */
  maxSize?: number;

  /**
   * Orientation of the resize handle
   * @defaultValue 'horizontal'
   */
  orientation?: ResizablePanelOrientation;

  /**
   * Whether panel is pinned (push mode)
   */
  isPinned?: boolean;

  /**
   * Callback when pin state changes
   */
  onPinChange?: (pinned: boolean) => void;

  /**
   * Callback when close button clicked
   */
  onClose?: () => void;

  /**
   * Additional CSS class
   */
  className?: string;
}

/**
 * Resizable panel with pin toggle
 *
 * Features:
 * - Drag handle for resizing (horizontal or vertical)
 * - Pin toggle (pinned = push mode, unpinned = overlay)
 * - Close button
 * - Scrollable content area
 * @param props - Component props
 */
export function ResizablePanel(props: ResizablePanelProps) {
  const {
    title,
    children,
    size,
    onSizeChange,
    minSize = 280,
    maxSize = 480,
    orientation = 'horizontal',
    isPinned = false,
    onPinChange,
    onClose,
    className,
  } = props;
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(size);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  const clampSize = useCallback(
    (nextSize: number) => Math.min(maxSize, Math.max(minSize, nextSize)),
    [maxSize, minSize],
  );

  const adjustSizeBy = useCallback(
    (delta: number) => {
      onSizeChange(clampSize(size + delta));
    },
    [clampSize, onSizeChange, size],
  );

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setIsDragging(true);
      startPosRef.current = orientation === 'horizontal' ? e.clientX : e.clientY;
      startSizeRef.current = size;

      const handleMouseMove = (e: globalThis.MouseEvent) => {
        const currentPos = orientation === 'horizontal' ? e.clientX : e.clientY;
        const delta = startPosRef.current - currentPos;
        onSizeChange(clampSize(startSizeRef.current + delta));
      };

      // Keep a cleanup ref so unmount can detach a drag in progress without
      // firing state updates after the panel is gone.
      const removeDragListeners = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        removeDragListeners();
        cleanupDragRef.current = null;
      };

      cleanupDragRef.current = removeDragListeners;
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [clampSize, onSizeChange, orientation, size],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const isIncrease = orientation === 'horizontal' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
      const isDecrease = orientation === 'horizontal' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';

      if (!isIncrease && !isDecrease) {
        return;
      }

      event.preventDefault();
      adjustSizeBy(isIncrease ? 16 : -16);
    },
    [adjustSizeBy, orientation],
  );

  useEffect(
    () => () => {
      cleanupDragRef.current?.();
      cleanupDragRef.current = null;
    },
    [],
  );

  return (
    <div data-component="ResizablePanel" className={`${styles.container} ${styles[orientation]} ${className ?? ''}`}>
      <div
        className={`${styles.handle} ${isDragging ? styles.dragging : ''}`}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="separator"
        aria-orientation={orientation}
        aria-valuenow={size}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
      />
      <div className={styles.content}>
        {(title || onPinChange || onClose) && (
          <div className={styles.header}>
            <span className={styles.headerTitle}>{title}</span>
            <div className={styles.headerActions}>
              {onPinChange && (
                <button
                  type="button"
                  className={`${styles.iconButton} ${isPinned ? styles.active : ''}`}
                  onClick={() => onPinChange(!isPinned)}
                  aria-pressed={isPinned}
                  aria-label={isPinned ? 'Unpin panel' : 'Pin panel'}
                  title={isPinned ? 'Unpin (overlay mode)' : 'Pin (push mode)'}
                >
                  {isPinned ? <Pin size={16} /> : <PinOff size={16} />}
                </button>
              )}
              {onClose && (
                <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close panel">
                  <X size={16} />
                </button>
              )}
            </div>
          </div>
        )}
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}

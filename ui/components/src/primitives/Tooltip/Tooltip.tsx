import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import styles from './Tooltip.module.scss';

export type TooltipPosition = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps extends Omit<HTMLAttributes<HTMLDivElement>, 'content'> {
  /**
   * Content to display in the tooltip
   */
  content: ReactNode;
  /**
   * Position of the tooltip relative to the trigger element
   */
  position?: TooltipPosition;
  /**
   * Delay in milliseconds before showing the tooltip
   */
  delay?: number;
  /**
   * Trigger element that activates the tooltip on hover.
   * Must be a single React element. Typed with `Record<string, unknown>` props
   * so that the component can safely read and forward `aria-describedby`.
   */
  children: ReactElement<Record<string, unknown>>;
}

/**
 * Tooltip component
 *
 * Displays additional information on hover with glass panel styling.
 * Supports positioning on all four sides with configurable delay.
 * @param props - Component props
 * @returns Rendered tooltip with trigger
 */
export function Tooltip({ content, position = 'top', delay = 300, children, className, ...props }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable id links the tooltip element (role="tooltip") to its trigger via
  // aria-describedby, satisfying the ARIA tooltip pattern.
  const tooltipId = useId();

  const calculatePosition = useCallback(() => {
    if (!triggerRef.current || !tooltipRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();

    // Portal renders at document.body, so position:fixed uses viewport coords directly.
    // getBoundingClientRect() returns viewport-relative values — no scroll offset needed.
    const gap = 8;
    let top = 0;
    let left = 0;

    switch (position) {
      case 'top':
        top = triggerRect.top - tooltipRect.height - gap;
        left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
        break;
      case 'bottom':
        top = triggerRect.bottom + gap;
        left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
        break;
      case 'left':
        top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
        left = triggerRect.left - tooltipRect.width - gap;
        break;
      case 'right':
        top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
        left = triggerRect.right + gap;
        break;
    }

    const padding = 8;
    const maxLeft = window.innerWidth - tooltipRect.width - padding;
    const maxTop = window.innerHeight - tooltipRect.height - padding;

    left = Math.max(padding, Math.min(left, maxLeft));
    top = Math.max(padding, Math.min(top, maxTop));

    setTooltipStyle({ top, left });
  }, [position]);

  /** Cancel any pending show timer and reset the ref to null. */
  const clearPendingShow = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const showTooltip = useCallback(() => {
    clearPendingShow();
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true);
      requestAnimationFrame(calculatePosition);
    }, delay);
  }, [clearPendingShow, delay, calculatePosition]);

  const hideTooltip = useCallback(() => {
    clearPendingShow();
    setIsVisible(false);
  }, [clearPendingShow]);

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const nextFocused = event.relatedTarget;
      if (nextFocused instanceof Node && triggerRef.current?.contains(nextFocused)) {
        return;
      }
      hideTooltip();
    },
    [hideTooltip],
  );

  const handleMouseLeave = useCallback(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof Node && triggerRef.current?.contains(activeElement)) {
      return;
    }
    hideTooltip();
  }, [hideTooltip]);

  useEffect(() => {
    if (!isVisible) return;

    const handleUpdate = () => {
      calculatePosition();
    };

    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);

    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [isVisible, calculatePosition]);

  useEffect(() => {
    return () => {
      clearPendingShow();
    };
  }, [clearPendingShow]);

  // Guard against non-DOM environments (SSR / test environments without
  // document.body). createPortal throws when document.body is absent.
  const portalContainer = typeof document !== 'undefined' ? document.body : null;

  // Merge any pre-existing aria-describedby on the child with the tooltip id.
  const existingAriaDescribedBy = children.props['aria-describedby'];
  const existingDescribedBy = typeof existingAriaDescribedBy === 'string' ? existingAriaDescribedBy : undefined;
  const mergedDescribedBy = isVisible
    ? [existingDescribedBy, tooltipId].filter(Boolean).join(' ') || undefined
    : existingDescribedBy;

  return (
    <div
      data-component="Tooltip"
      ref={triggerRef}
      className={styles.triggerWrapper}
      onMouseEnter={showTooltip}
      onMouseLeave={handleMouseLeave}
      onFocus={showTooltip}
      onBlur={handleBlur}
    >
      {React.cloneElement(children, {
        'aria-describedby': mergedDescribedBy,
      })}
      {isVisible &&
        portalContainer &&
        createPortal(
          <div
            id={tooltipId}
            ref={tooltipRef}
            className={clsx(styles.tooltip, styles[position], className)}
            style={tooltipStyle}
            role="tooltip"
            {...props}
          >
            <div className={styles.arrow} />
            <div className={styles.content}>{content}</div>
          </div>,
          portalContainer,
        )}
    </div>
  );
}

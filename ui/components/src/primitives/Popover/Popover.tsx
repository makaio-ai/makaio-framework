import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import styles from './Popover.module.scss';

/**
 * Popover component props.
 *
 * Supports both controlled and uncontrolled open state.
 * When `open` and `onOpenChange` are provided, the component is controlled.
 * When omitted, the component manages open state internally.
 */
export interface PopoverProps {
  /** Trigger element that toggles the popover */
  trigger: ReactElement;
  /** Popover content */
  children: ReactNode;
  /** Alignment relative to trigger */
  align?: 'start' | 'end';
  /** Controlled open state (optional, uncontrolled by default) */
  open?: boolean;
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void;
  /** Accessible label for the dialog panel. */
  ariaLabel?: string;
  /** Accessible labelled-by id for the dialog panel. */
  ariaLabelledBy?: string;
}

/**
 * Popover primitive component.
 *
 * Floating panel anchored below a trigger element.
 * Supports:
 * - Click trigger to toggle open/close
 * - Escape key to close
 * - Click outside to close
 * - Controlled (`open` + `onOpenChange`) and uncontrolled modes
 * - Start or end alignment relative to the trigger
 * @param props - Popover component properties
 * @returns Popover component
 */
export function Popover({
  trigger,
  children,
  align = 'start',
  open: controlledOpen,
  onOpenChange,
  ariaLabel,
  ariaLabelledBy,
}: PopoverProps) {
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const panelId = useId();

  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Notify open state change. Updates internal state when uncontrolled,
   * always calls the optional `onOpenChange` callback.
   * @param next - The next open state
   */
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next);
      }
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  /**
   * Toggle the popover open/closed.
   */
  const handleTriggerClick = useCallback(() => {
    setOpen(!isOpen);
  }, [isOpen, setOpen]);

  /**
   * Handle keyboard events — Escape closes the popover.
   * @param e - KeyboardEvent for the key press (Escape closes the popover)
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    },
    [setOpen],
  );

  /**
   * Handle click outside the popover container to close.
   * Both trigger and panel are children of containerRef, so a single check suffices.
   * @param e - MouseEvent used to detect clicks outside the container
   */
  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    },
    [setOpen],
  );

  // Attach and detach global listeners based on open state
  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.addEventListener('mousedown', handleClickOutside);

      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen, handleKeyDown, handleClickOutside]);

  const triggerProps = (trigger.props as Record<string, unknown>) ?? {};
  const triggerAriaLabel = typeof triggerProps['aria-label'] === 'string' ? triggerProps['aria-label'] : undefined;
  const dialogA11yProps = ariaLabelledBy
    ? { 'aria-labelledby': ariaLabelledBy }
    : { 'aria-label': ariaLabel ?? triggerAriaLabel ?? 'Popover' };
  const isNativeButton = typeof trigger.type === 'string' && trigger.type === 'button';
  const handleTriggerKeyDown = (event: unknown): void => {
    const keyboardEvent = event as { key?: string; preventDefault: () => void; defaultPrevented?: boolean };
    const onKeyDown = triggerProps.onKeyDown as ((e: unknown) => void) | undefined;
    onKeyDown?.(event);
    if (keyboardEvent.defaultPrevented) {
      return;
    }
    if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
      keyboardEvent.preventDefault();
      handleTriggerClick();
    }
  };
  const enhancedTrigger = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        'aria-expanded': isOpen,
        'aria-haspopup': 'dialog',
        'aria-controls': panelId,
        ...(isNativeButton
          ? {}
          : {
              role: triggerProps.role ?? 'button',
              tabIndex: triggerProps.tabIndex ?? 0,
              onKeyDown: handleTriggerKeyDown,
            }),
        onClick: (event: unknown) => {
          const nextEvent = event as { defaultPrevented?: boolean };
          const onClick = triggerProps.onClick as ((e: unknown) => void) | undefined;
          onClick?.(event);
          if (!nextEvent.defaultPrevented) {
            handleTriggerClick();
          }
        },
      })
    : trigger;

  return (
    <div data-component="Popover" className={styles.popoverContainer} ref={containerRef}>
      <div className={styles.triggerWrapper}>{enhancedTrigger}</div>

      {isOpen && (
        <div id={panelId} className={`${styles.popoverPanel} ${styles[align]}`} role="dialog" {...dialogA11yProps}>
          {children}
        </div>
      )}
    </div>
  );
}

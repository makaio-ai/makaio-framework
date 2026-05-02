/**
 * FatalErrorDialog - Self-contained fatal error modal
 *
 * Pure component with inline styles, designed to render outside ThemeProvider.
 * Uses native HTML dialog element with showModal()/close() API.
 * Escape key and backdrop click dismissal are intentionally disabled — the caller
 * must explicitly provide action buttons to resolve the error state.
 */

import { useEffect, useId, useRef } from 'react';
import type { CSSProperties, MouseEvent } from 'react';

type NonEmptyArray<T> = [T, ...T[]];

/**
 * A single action button rendered in the FatalErrorDialog footer.
 * @param id - Unique identifier passed back to onAction
 * @param label - Display text for the button
 * @param variant - Visual style: 'primary' (highlighted) or 'secondary' (muted)
 */
export interface FatalErrorDialogAction {
  /** Unique identifier passed back to onAction */
  id: string;
  /** Display text for the button */
  label: string;
  /** Visual style variant */
  variant?: 'primary' | 'secondary';
}

/**
 * Props for the FatalErrorDialog component.
 * @param isOpen - Whether the dialog is currently visible
 * @param title - Short error title shown in the dialog header
 * @param message - Human-readable description of the error
 * @param details - Optional technical details (e.g. raw error message) shown in a collapsible section
 * @param actions - Ordered list of action buttons; must contain at least one action
 * @param onAction - Called with the action id when a button is clicked
 */
export interface FatalErrorDialogProps {
  /** Whether the dialog is open. */
  isOpen: boolean;
  /** Error title. */
  title: string;
  /** Error description. */
  message: string;
  /** Technical details (error message). */
  details?: string;
  /** Action buttons. */
  actions: NonEmptyArray<FatalErrorDialogAction>;
  /** Called when an action button is clicked. */
  onAction: (actionId: string) => void;
}

const styles = {
  dialog: {
    border: 'none',
    borderRadius: '12px',
    background: '#1a1a1f',
    color: '#e8e8ed',
    padding: '0',
    width: '480px',
    maxWidth: '90vw',
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
  } satisfies CSSProperties,

  backdrop: {
    // Prevent backdrop click from closing (we don't propagate, but we also
    // visually darken the backdrop via the ::backdrop pseudo-element which
    // we cannot target in inline styles — this is acceptable for the use case)
  } satisfies CSSProperties,

  content: {
    padding: '32px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
  } satisfies CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  } satisfies CSSProperties,

  icon: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    background: 'rgba(239, 68, 68, 0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: '16px',
    lineHeight: 1,
  } satisfies CSSProperties,

  title: {
    margin: '0',
    fontSize: '18px',
    fontWeight: 600,
    color: '#f5f5f7',
    lineHeight: 1.3,
  } satisfies CSSProperties,

  message: {
    margin: '0',
    fontSize: '14px',
    color: '#ababba',
    lineHeight: 1.6,
  } satisfies CSSProperties,

  details: {
    borderRadius: '8px',
    background: '#111115',
    border: '1px solid #2a2a35',
    overflow: 'hidden',
  } satisfies CSSProperties,

  detailsSummary: {
    padding: '10px 14px',
    fontSize: '12px',
    fontWeight: 500,
    color: '#6b6b7a',
    cursor: 'pointer',
    userSelect: 'none' as const,
    listStyle: 'none',
  } satisfies CSSProperties,

  detailsBody: {
    padding: '0 14px 12px',
    fontSize: '12px',
    fontFamily: 'monospace',
    color: '#8b8b9a',
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
    whiteSpace: 'pre-wrap' as const,
  } satisfies CSSProperties,

  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '10px',
    paddingTop: '8px',
  } satisfies CSSProperties,

  buttonBase: {
    padding: '8px 20px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    transition: 'opacity 0.15s',
    fontFamily: 'inherit',
  } satisfies CSSProperties,

  buttonPrimary: {
    background: '#ef4444',
    color: '#ffffff',
  } satisfies CSSProperties,

  buttonSecondary: {
    background: '#2a2a35',
    color: '#c8c8d3',
  } satisfies CSSProperties,
} as const;

/**
 * Modal dialog for fatal, unrecoverable application errors.
 *
 * Intentionally self-contained with inline styles so it renders correctly even
 * when mounted outside `ThemeProvider`. Escape key and backdrop click are
 * suppressed — the caller must resolve the error via the provided action buttons.
 * @param props - Component props
 * @example
 * ```tsx
 * <FatalErrorDialog
 *   isOpen={hasFatalError}
 *   title="Connection lost"
 *   message="The relay connection could not be established."
 *   details={error.message}
 *   actions={[{ id: 'reload', label: 'Reload', variant: 'primary' }]}
 *   onAction={(id) => id === 'reload' && window.location.reload()}
 * />
 * ```
 */
export function FatalErrorDialog(props: FatalErrorDialogProps) {
  const { isOpen, title, message, details, actions, onAction } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  if (actions.length === 0) {
    throw new Error('FatalErrorDialog requires at least one action.');
  }

  // Open / close the native dialog based on the isOpen prop
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  // Prevent Escape key from closing the dialog
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleCancel = (e: Event) => {
      e.preventDefault();
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, []);

  /**
   * Swallow backdrop clicks so the dialog cannot be dismissed by clicking outside.
   * @param e - The mouse event from the dialog element
   */
  const handleDialogClick = (e: MouseEvent<HTMLDialogElement>) => {
    // Clicks on the <dialog> itself (i.e. the backdrop) must not propagate further
    e.stopPropagation();
  };

  /**
   * Stop content clicks from reaching the dialog backdrop handler.
   * @param e - The mouse event from the content wrapper
   */
  const handleContentClick = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  return (
    <dialog
      data-component="FatalErrorDialog"
      ref={dialogRef}
      style={styles.dialog}
      aria-labelledby={titleId}
      onClick={handleDialogClick}
    >
      <div style={styles.content} onClick={handleContentClick}>
        <div style={styles.header}>
          <span style={styles.icon} aria-hidden="true">
            {'!'}
          </span>
          <h2 id={titleId} style={styles.title}>
            {title}
          </h2>
        </div>

        <p style={styles.message}>{message}</p>

        {details !== undefined && (
          <details style={styles.details}>
            <summary style={styles.detailsSummary}>Technical details</summary>
            <div style={styles.detailsBody}>{details}</div>
          </details>
        )}

        <div style={styles.actions}>
          {actions.map((action) => (
            <button
              type="button"
              key={action.id}
              style={{
                ...styles.buttonBase,
                ...(action.variant === 'primary' ? styles.buttonPrimary : styles.buttonSecondary),
              }}
              onClick={() => onAction(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}

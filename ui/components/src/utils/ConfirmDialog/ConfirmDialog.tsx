/**
 * ConfirmDialog - Modal confirmation dialog component
 *
 * Native HTML dialog element with glass panel styling.
 * Supports multiple action options with different variants (primary, secondary, danger).
 * Handles backdrop click and escape key for dismissal.
 */

import { useEffect, useId, useRef } from 'react';
import { Button } from '../../primitives/Button';
import styles from './ConfirmDialog.module.scss';

/**
 * Single action option for the confirmation dialog.
 * @param id - Unique identifier for the option (passed to onSelect)
 * @param label - Display text for the button
 * @param variant - Visual style variant (primary, secondary, danger)
 * @param disabled - Whether the option is disabled
 */
export interface ConfirmDialogOption {
  /** Unique identifier for the option */
  id: string;
  /** Display text for the button */
  label: string;
  /** Visual style variant */
  variant?: 'primary' | 'secondary' | 'danger';
  /** Whether the option is disabled */
  disabled?: boolean;
}

interface ConfirmDialogBaseProps {
  /** Whether the dialog is currently open */
  isOpen: boolean;
  /** Dialog title text */
  title: string;
  /** Dialog message/description text */
  message: string;
  /** Optional detailed description text */
  details?: string;
  /** Show "Don't ask again" checkbox */
  showDontAskAgain?: boolean;
  /** Current checkbox state */
  dontAskAgain?: boolean;
  /** Checkbox change callback */
  onDontAskAgainChange?: (checked: boolean) => void;
  /** Array of action options to display */
  options: ConfirmDialogOption[];
  /** Callback when an option is selected */
  onSelect: (optionId: string) => void;
  /** Optional callback when dialog is dismissed */
  onClose?: () => void;
  /** Optional positioning class or coordinates */
  position?: 'center' | 'top-center' | 'bottom-center';
}

interface ConfirmDialogWithDontAskAgain extends ConfirmDialogBaseProps {
  /** Show "Don't ask again" checkbox */
  showDontAskAgain: true;
  /** Current checkbox state */
  dontAskAgain: boolean;
  /** Checkbox change callback */
  onDontAskAgainChange: (checked: boolean) => void;
}

interface ConfirmDialogWithoutDontAskAgain extends ConfirmDialogBaseProps {
  /** Show "Don't ask again" checkbox */
  showDontAskAgain?: false;
  /** Current checkbox state */
  dontAskAgain?: never;
  /** Checkbox change callback */
  onDontAskAgainChange?: never;
}

export type ConfirmDialogProps = ConfirmDialogWithDontAskAgain | ConfirmDialogWithoutDontAskAgain;

/**
 * Modal confirmation dialog using native HTML dialog element.
 *
 * Features:
 * - Native dialog element with showModal()/close() API
 * - Glass panel styling with backdrop blur
 * - Action buttons with variant support (primary, secondary, danger)
 * - Escape key and backdrop click dismissal
 * - Theme-aware styling via CSS custom properties
 * @param props - Component props
 * @example
 * ```tsx
 * <ConfirmDialog
 *   isOpen={showDialog}
 *   title="Delete Session?"
 *   message="This action cannot be undone."
 *   options={[
 *     { id: 'cancel', label: 'Cancel', variant: 'secondary' },
 *     { id: 'delete', label: 'Delete', variant: 'danger' },
 *   ]}
 *   onSelect={(id) => handleSelection(id)}
 *   onClose={() => setShowDialog(false)}
 * />
 * ```
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    isOpen,
    title,
    message,
    details,
    showDontAskAgain,
    dontAskAgain,
    onDontAskAgainChange,
    options,
    onSelect,
    onClose,
    position = 'center',
  } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  const detailsId = useId();

  // Handle dialog open/close state
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  // Handle Escape key - sync with parent state via onClose
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose?.();
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  /**
   * Handle backdrop click - closes dialog when clicking the backdrop area ( outside the modal content)
   * @param e - Mouse event from the click
   */
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === dialogRef.current && onClose) {
      onClose();
    }
  };

  const dialogClassNames = [styles.dialog, position && styles[`position-${position}`]].filter(Boolean).join(' ');
  const descriptionIds = [messageId, details ? detailsId : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <dialog
      data-component="ConfirmDialog"
      ref={dialogRef}
      className={dialogClassNames}
      aria-labelledby={titleId}
      aria-describedby={descriptionIds}
      onClick={handleBackdropClick}
    >
      <div className={styles.content}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={messageId} className={styles.message}>
          {message}
        </p>
        {details && (
          <p id={detailsId} className={styles.details}>
            {details}
          </p>
        )}
        {showDontAskAgain && (
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(event) => onDontAskAgainChange?.(event.target.checked)}
            />
            <span>Do not show this warning again</span>
          </label>
        )}
        <div className={styles.actions}>
          {options.map((option) => (
            <Button
              key={option.id}
              variant={option.variant ?? 'secondary'}
              onClick={() => onSelect(option.id)}
              disabled={option.disabled}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    </dialog>
  );
}

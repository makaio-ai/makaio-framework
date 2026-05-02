/**
 * PromptDialog - Modal text input dialog component
 *
 * Native HTML dialog element with glass panel styling.
 * Supports single-line input or multiline textarea.
 * Handles backdrop click and escape key for dismissal.
 */

import { useEffect, useRef, useState, useCallback, useId, type KeyboardEvent } from 'react';
import { Button } from '../../primitives/Button';
import styles from './PromptDialog.module.scss';

/**
 * Props for PromptDialog component
 * @param isOpen - Whether the dialog is currently open
 * @param title - Dialog title text
 * @param message - Dialog message/description text
 * @param placeholder - Placeholder text for the input field
 * @param defaultValue - Initial value for the input field
 * @param multiline - Whether to use a multiline textarea
 * @param submitLabel - Label for the submit button
 * @param cancelLabel - Label for the cancel button
 * @param onSubmit - Callback when text is submitted - receives the entered text
 * @param onClose - Callback when dialog is dismissed (escape/backdrop/cancel)
 */
export interface PromptDialogProps {
  /** Whether the dialog is currently open */
  isOpen: boolean;
  /** Dialog title text */
  title: string;
  /** Dialog message/description text */
  message: string;
  /** Placeholder text for the input field */
  placeholder?: string;
  /** Initial value for the input field */
  defaultValue?: string;
  /** Whether to use a multiline textarea */
  multiline?: boolean;
  /** Label for the submit button */
  submitLabel?: string;
  /** Label for the cancel button */
  cancelLabel?: string;
  /** Callback when text is submitted */
  onSubmit: (value: string) => void;
  /** Callback when dialog is dismissed */
  onClose: () => void;
}

/**
 * Modal text input dialog using native HTML dialog element.
 *
 * Features:
 * - Native dialog element with showModal()/close() API
 * - Glass panel styling with backdrop blur
 * - Single-line input or multiline textarea mode
 * - Enter key submits (Ctrl/Cmd+Enter for multiline)
 * - Escape key and backdrop click dismissal
 * - Theme-aware styling via CSS custom properties
 * @param props - Component props
 * @example
 * ```tsx
 * <PromptDialog
 *   isOpen={showPrompt}
 *   title="Add Comment"
 *   message="Enter your comment for this line."
 *   placeholder="Write your comment..."
 *   multiline
 *   onSubmit={(text) => handleComment(text)}
 *   onClose={() => setShowPrompt(false)}
 * />
 * ```
 */
export function PromptDialog(props: PromptDialogProps) {
  const {
    isOpen,
    title,
    message,
    placeholder,
    defaultValue = '',
    multiline = false,
    submitLabel = 'Submit',
    cancelLabel = 'Cancel',
    onSubmit,
    onClose,
  } = props;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [value, setValue] = useState(defaultValue);
  const titleId = useId();
  const messageId = useId();
  const hintId = useId();

  // Reset value when dialog opens with new defaultValue
  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
    }
  }, [isOpen, defaultValue]);

  // Handle dialog open/close state
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
      // Focus input after dialog opens
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
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
      onClose();
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  /**
   * Handle backdrop click - closes dialog when clicking the backdrop area
   * @param e - Mouse event from the click
   */
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === dialogRef.current) {
      onClose();
    }
  };

  /**
   * Handle form submission
   */
  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  }, [value, onSubmit]);

  /**
   * Handle keyboard events for submission
   * - Enter submits for single-line input
   * - Ctrl/Cmd+Enter submits for multiline textarea
   * @param e - Keyboard event
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Enter') {
        if (multiline) {
          // Ctrl/Cmd+Enter to submit in multiline mode
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleSubmit();
          }
        } else {
          // Enter to submit in single-line mode
          e.preventDefault();
          handleSubmit();
        }
      }
    },
    [multiline, handleSubmit],
  );

  const canSubmit = value.trim().length > 0;
  // Guard platform detection for non-browser test/SSR environments.
  const isMacPlatform =
    typeof navigator !== 'undefined' && typeof navigator.platform === 'string' && navigator.platform.includes('Mac');
  // Use visible title/message as the accessible name/description for the input.
  const describedBy = multiline ? `${messageId} ${hintId}` : messageId;

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      data-component="PromptDialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onClick={handleBackdropClick}
    >
      <div className={styles.content}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={messageId} className={styles.message}>
          {message}
        </p>

        <div className={styles.inputContainer}>
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              className={styles.textarea}
              aria-labelledby={titleId}
              aria-describedby={describedBy}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={5}
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              className={styles.input}
              aria-labelledby={titleId}
              aria-describedby={describedBy}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
            />
          )}
          {multiline && (
            <span id={hintId} className={styles.hint}>
              Press {isMacPlatform ? '⌘' : 'Ctrl'}+Enter to submit
            </span>
          )}
        </div>

        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

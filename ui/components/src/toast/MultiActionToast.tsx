import type { ReactNode } from 'react';
import styles from './MultiActionToast.module.scss';

export interface MultiActionToastAction {
  /** Stable action identifier forwarded to the action callback. */
  id: string;
  /** Visible button label. */
  label: string;
  /** Visual treatment for the action button. */
  variant?: 'default' | 'destructive' | 'outline';
}

export interface MultiActionToastPayload {
  /** Main message content to display. */
  message: string;
  /** Optional title/headline for the toast. */
  title?: string;
  /** Optional action buttons attached to the toast. */
  actions?: MultiActionToastAction[];
}

export interface MultiActionToastProps {
  /** Toast display payload rendered by this component. */
  payload: MultiActionToastPayload;
  /** Callback when an action is clicked */
  onAction: (actionId: string) => void;
  /** Callback when toast is dismissed */
  onDismiss: () => void;
}

/**
 * Multi-action toast notification component.
 *
 * Pure UI component for displaying toasts with multiple interactive actions.
 * Renders actions as buttons with appropriate variants.
 * @param payload - Toast data including title, message, and actions
 * @param onAction - Callback when an action button is clicked
 * @param onDismiss - Callback when the dismiss button is clicked
 * @returns Multi-action toast component
 * @example
 * ```tsx
 * <MultiActionToast
 *   payload={{
 *     title: 'Unsaved Changes',
 *     message: 'You have unsaved changes. Do you want to save them?',
 *     actions: [
 *       { id: 'save', label: 'Save', variant: 'default' },
 *       { id: 'discard', label: 'Discard', variant: 'destructive' },
 *     ],
 *   }}
 *   onAction={(id) => console.log('Action:', id)}
 *   onDismiss={() => console.log('Dismissed')}
 * />
 * ```
 */
export function MultiActionToast({ payload, onAction, onDismiss }: MultiActionToastProps): ReactNode {
  const { title, message, actions = [] } = payload;

  return (
    <div data-component="MultiActionToast" className={styles.root}>
      <div className={styles.content}>
        {title && <div className={styles.title}>{title}</div>}
        <div className={styles.message}>{message}</div>
      </div>
      <div className={styles.actions}>
        {actions.map((action) => (
          <button
            key={action.id}
            className={`${styles.action} ${styles[action.variant ?? 'default']}`}
            onClick={() => onAction(action.id)}
            type="button"
          >
            {action.label}
          </button>
        ))}
        <button className={`${styles.action} ${styles.dismiss}`} onClick={onDismiss} type="button">
          Dismiss
        </button>
      </div>
    </div>
  );
}

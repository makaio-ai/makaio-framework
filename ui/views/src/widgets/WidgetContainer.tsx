/**
 * WidgetContainer - Wrapper for individual widget instances
 *
 * Provides:
 * - Size-based styling
 * - Error boundaries
 * - Remove button
 */

import { Component, useState, type ReactNode } from 'react';
import type { WidgetSize } from '@makaio/ui-kernel';
import styles from './WidgetContainer.module.scss';

export interface WidgetContainerProps {
  /**
   * Widget instance ID
   */
  instanceId: string;

  /**
   * Widget title
   */
  title: string;

  /**
   * Current size
   */
  size: WidgetSize;

  /**
   * Widget content
   */
  children: ReactNode;

  /**
   * Called when remove button clicked
   */
  onRemove?: () => void;
}

interface ErrorBoundaryProps {
  /**
   * Content to render
   */
  children: ReactNode;

  /**
   * Called when an error is caught
   */
  onError: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Simple error boundary for widget content
 *
 * React requires class components for error boundaries.
 * This catches render errors in children and notifies the parent.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /**
   * Creates an ErrorBoundary instance
   * @param props - Component props
   */
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  /**
   * Update state when an error is caught
   * @returns New state with hasError set to true
   */
  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  /**
   * Handle caught errors by notifying parent
   */
  public componentDidCatch(): void {
    this.props.onError();
  }

  /**
   * Render children or nothing if error occurred
   * @returns Children or null
   */
  public render(): ReactNode {
    if (this.state.hasError) {
      return null;
    }

    return this.props.children;
  }
}

/**
 * WidgetContainer component
 *
 * Wraps widget content with chrome (title bar, remove button).
 * Applies size-based styling.
 * @param props - Component props
 * @returns React component
 */
export function WidgetContainer({ instanceId, title, size, children, onRemove }: WidgetContainerProps) {
  const [hasError, setHasError] = useState(false);

  // Simple error boundary pattern
  if (hasError) {
    return (
      <div className={`${styles.container} ${styles[size]} ${styles.error}`}>
        <div className={styles.header}>
          <span className={styles.title}>{title}</span>
        </div>
        <div className={styles.content}>
          <p className={styles.errorMessage}>Widget failed to render</p>
          <button type="button" className={styles.retryButton} onClick={() => setHasError(false)}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.container} ${styles[size]}`} data-widget-instance={instanceId}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        {onRemove && (
          <button
            type="button"
            className={styles.removeButton}
            onClick={onRemove}
            aria-label="Remove widget"
            title="Remove widget"
          >
            ×
          </button>
        )}
      </div>
      <div className={styles.content}>
        <ErrorBoundary onError={() => setHasError(true)}>{children}</ErrorBoundary>
      </div>
    </div>
  );
}

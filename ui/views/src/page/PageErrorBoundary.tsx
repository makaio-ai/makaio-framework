import { Component, type ReactNode, type ErrorInfo } from 'react';
import styles from './PageErrorBoundary.module.scss';

/**
 * Props for {@link PageErrorBoundary}.
 */
interface PageErrorBoundaryProps {
  /** Page ID for error reporting. */
  pageId: string;
  /** Child components. */
  children: ReactNode;
  /** Optional fallback UI rendered instead of the default error card. */
  fallback?: ReactNode;
}

/**
 * Internal state for {@link PageErrorBoundary}.
 */
interface PageErrorBoundaryState {
  /** Whether a render error has been caught. */
  hasError: boolean;
  /** The caught error, if any. */
  error: Error | null;
}

/**
 * Error boundary for page rendering.
 *
 * Catches render errors thrown inside a page's component tree and shows a
 * user-friendly fallback with a retry button.  If a `fallback` prop is
 * supplied it is rendered instead of the default error card.
 */
export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  public constructor(props: PageErrorBoundaryProps) {
    super(props);
    this.state = { error: null, hasError: false };
  }

  /**
   * Transition to error state so the next render shows the fallback UI.
   * @param error - The error thrown during rendering.
   * @returns Updated state slice.
   */
  public static getDerivedStateFromError(error: Error): PageErrorBoundaryState {
    return { error, hasError: true };
  }

  /**
   * Log the caught error with page context for debugging.
   * @param error - The error that was thrown.
   * @param errorInfo - React component stack information.
   */
  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[PageErrorBoundary] Error rendering page "${this.props.pageId}":`, error, errorInfo);
  }

  /**
   * Reset the error state so the page is allowed to re-render.
   */
  private readonly handleRetry = (): void => {
    this.setState({ error: null, hasError: false });
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className={styles.errorContainer} data-component="PageErrorBoundary">
          <h2 className={styles.title}>Something went wrong</h2>
          <p className={styles.subtitle}>Failed to render page &quot;{this.props.pageId}&quot;</p>
          <pre className={styles.errorMessage}>{this.state.error?.message}</pre>
          <button className={styles.retryButton} onClick={this.handleRetry} type="button">
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

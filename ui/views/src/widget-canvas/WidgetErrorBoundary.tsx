import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';

/**
 * Props for {@link WidgetErrorBoundary}.
 */
interface WidgetErrorBoundaryProps {
  /** The widget subtree to protect. */
  children: ReactNode;
  /**
   * The widget ID, used to identify which widget crashed in log output.
   */
  widgetId: string;
}

/**
 * Internal state for {@link WidgetErrorBoundary}.
 */
interface WidgetErrorBoundaryState {
  /** Whether a render error has been caught. */
  hasError: boolean;
}

const containerStyle: CSSProperties = {
  alignItems: 'center',
  background: 'rgba(220, 38, 38, 0.08)',
  border: '1px solid rgba(220, 38, 38, 0.3)',
  borderRadius: '6px',
  boxSizing: 'border-box',
  color: '#dc2626',
  display: 'flex',
  flexDirection: 'column',
  fontSize: '13px',
  gap: '8px',
  height: '100%',
  justifyContent: 'center',
  padding: '12px',
  width: '100%',
};

const retryButtonStyle: CSSProperties = {
  background: 'rgba(220, 38, 38, 0.12)',
  border: '1px solid rgba(220, 38, 38, 0.4)',
  borderRadius: '4px',
  color: '#dc2626',
  cursor: 'pointer',
  fontSize: '12px',
  padding: '4px 10px',
};

/**
 * A minimal React error boundary that catches render errors thrown by a
 * single widget and displays an inline recovery UI.
 *
 * React error boundaries must be class components; this component exists
 * solely at the framework layer and intentionally uses inline styles so it
 * carries no dependency on CSS modules or host theme tokens.
 * @example
 * ```tsx
 * <WidgetErrorBoundary widgetId={placement.widgetId}>
 *   <Widget ... />
 * </WidgetErrorBoundary>
 * ```
 */
export class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  public override state: WidgetErrorBoundaryState = { hasError: false };

  /**
   * Update state so the next render shows the fallback UI.
   * @param _error - The error that was thrown.
   * @returns The updated state slice.
   */
  public static getDerivedStateFromError(_error: unknown): WidgetErrorBoundaryState {
    return { hasError: true };
  }

  /**
   * Log the caught error to the console with contextual widget information.
   * @param error - The error that was thrown during rendering.
   * @param info - React-supplied component stack information.
   */
  public override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      `[WidgetErrorBoundary] Widget "${this.props.widgetId}" failed to render:`,
      error,
      info.componentStack,
    );
  }

  /**
   * Reset the error state so the widget is allowed to re-render.
   */
  private readonly handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div data-component="WidgetErrorBoundary" style={containerStyle}>
          <p style={{ margin: 0 }}>Widget failed to render</p>
          <button onClick={this.handleRetry} style={retryButtonStyle} type="button">
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

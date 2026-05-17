/**
 * SheetOverlay - Framework-owned fullscreen sheet renderer
 *
 * Renders `sheet`-mode pages (and legacy `cover`-mode pages) as fullscreen
 * overlays that sit above the widget canvas without replacing the shell.
 *
 * The overlay mounts unconditionally inside `FrameworkShell` and renders
 * nothing when no page is active (`activePageId === null`). When a page is
 * activated it slides in from the right, traps focus, and can be dismissed
 * via the close button or the Escape key.
 * @packageDocumentation
 */

import {
  type JSX,
  type ReactNode,
  type RefObject,
  Component,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { usePageOverlayStore, usePageComponent } from '@makaio/ui-hooks';
import { isOverlayMode } from '@makaio/ui-kernel';
import { CloseIcon, useEscapeKey, useBodyScrollLock, useFocusOnOpen, useFocusTrap } from '@makaio/ui-components';
import styles from './sheet-overlay.module.scss';

// ---------------------------------------------------------------------------
// PageErrorBoundary
// ---------------------------------------------------------------------------

interface PageErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface PageErrorBoundaryProps {
  /** Page content to render. */
  children: ReactNode;
  /** Called when the user clicks Retry to reset the boundary. */
  onRetry: () => void;
}

/**
 * React class error boundary wrapping the Suspense boundary inside
 * `SheetOverlayContent`. Catches failed lazy imports and rendering
 * errors so the shell does not crash — the user sees a recoverable
 * error state instead.
 */
class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  public constructor(props: PageErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  public static getDerivedStateFromError(error: Error): PageErrorBoundaryState {
    return { hasError: true, error };
  }

  /**
   * Reset the error boundary and retry rendering.
   */
  public handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry();
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className={styles.errorState}>
          <span>Failed to load page.</span>
          <button className={styles.errorRetry} onClick={this.handleRetry} type="button">
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// SheetOverlayContent
// ---------------------------------------------------------------------------

/**
 * Inner content component — separated so `usePageComponent` is never called
 * conditionally. Only rendered when `activePageId` is non-null.
 * @param props - Inner overlay props.
 * @returns Overlay panel with the resolved page component inside.
 */
function SheetOverlayContent({
  pageId,
  internalRoute,
  onNavigate,
  onClose,
  titleId,
  panelRef,
}: {
  pageId: string;
  internalRoute: string | null;
  onNavigate: (route: string) => void;
  onClose: () => void;
  titleId: string;
  panelRef: RefObject<HTMLDivElement | null>;
}): JSX.Element | null {
  const [reloadKey, setReloadKey] = useState(0);
  const resolved = usePageComponent(pageId, reloadKey);
  const retryLoad = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  // Self-heal: if the resolved page is not an overlay-mode page, clear the
  // blocking overlay so the shell does not become stuck on an unreachable state.
  useEffect(() => {
    if (resolved && !isOverlayMode(resolved.definition.mode)) {
      onClose();
    }
  }, [resolved, onClose]);

  if (!resolved) {
    // Page registered but component not yet resolved — should not normally
    // reach here because usePageComponent returns undefined while loading,
    // but guard defensively.
    return null;
  }

  const { Component, definition } = resolved;

  // Only render overlay-mode pages; silently return nothing for switch-mode
  // pages (they are handled by the workspace navigation layer instead).
  if (!isOverlayMode(definition.mode)) {
    return null;
  }

  return (
    <div ref={panelRef} aria-labelledby={titleId} aria-modal className={styles.panel} role="dialog" tabIndex={-1}>
      <header className={styles.header}>
        <h2 className={styles.title} id={titleId}>
          {definition.name}
        </h2>
        <button aria-label="Close" className={styles.closeButton} onClick={onClose} type="button">
          <CloseIcon size={16} />
        </button>
      </header>

      <div className={styles.content}>
        <PageErrorBoundary key={`${pageId}:${reloadKey}`} onRetry={retryLoad}>
          <Suspense fallback={<div className={styles.loadingState}>Loading…</div>}>
            <Component internalRoute={internalRoute} onNavigate={onNavigate} />
          </Suspense>
        </PageErrorBoundary>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SheetOverlay
// ---------------------------------------------------------------------------

/**
 * Framework-owned sheet overlay renderer.
 *
 * Subscribes to {@link usePageOverlayStore} and renders a fullscreen overlay
 * when a sheet/cover page is active. Renders nothing when no page is active.
 *
 * Mount this once as a sibling of the main shell content so it floats above
 * the widget canvas without disrupting the layout flow.
 * @returns Overlay element (always mounted; empty when no page is active).
 */
export function SheetOverlay(): JSX.Element {
  const activePageId = usePageOverlayStore((s) => s.activePageId);
  const internalRoute = usePageOverlayStore((s) => s.internalRoute);
  const close = usePageOverlayStore((s) => s.close);
  const navigate = usePageOverlayStore((s) => s.navigate);

  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isOpen = activePageId !== null;

  useEscapeKey(close, isOpen);
  useBodyScrollLock(isOpen);
  useFocusOnOpen(panelRef, isOpen);
  useFocusTrap(panelRef, isOpen);

  const overlayClassName = `${styles.overlay}${isOpen ? ` ${styles.open}` : ''}`;

  return (
    <div className={overlayClassName} data-component="SheetOverlay">
      {activePageId !== null ? (
        <SheetOverlayContent
          internalRoute={internalRoute}
          onClose={close}
          onNavigate={navigate}
          pageId={activePageId}
          panelRef={panelRef}
          titleId={titleId}
        />
      ) : null}
    </div>
  );
}

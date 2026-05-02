import { lazy, Suspense, useEffect } from 'react';
import type { JSX } from 'react';
import type { IMakaioBus } from '@makaio/bus-core';
import { UiSubjects } from '@makaio/ui-kernel';
import type { UiReadyEvent } from '@makaio/ui-kernel';
import { BusProvider, useBus } from '@makaio/ui-hooks';
import { ExtensionBrowserLoader } from '@makaio/ui-views';

const LazyTrayView = lazy(() => import('@makaio/ui-views').then((m) => ({ default: m.TrayView })));

/**
 * Props for {@link App}.
 */
export interface AppProps {
  /**
   * Connected bus instance created by the shared renderer bootstrap.
   */
  readonly bus: IMakaioBus;
  /**
   * Surface identifier used for routing and emitted through `ui.ready`.
   */
  readonly surface: UiReadyEvent['surface'];
}

/**
 * Module-level guard that deduplicates `ui.ready` emission per surface across
 * React StrictMode mount/unmount remount cycles, while still allowing a later
 * real remount of the same surface to emit `ui.ready` again.
 */
const emittedReadySurfaces = new Set<UiReadyEvent['surface']>();
const emittedReadyResetTimers = new Map<UiReadyEvent['surface'], number>();

/**
 * Cancel any pending deferred reset for a renderer surface.
 * @param surface - Surface whose pending reset should be canceled.
 */
function cancelReadySurfaceReset(surface: UiReadyEvent['surface']): void {
  const pendingResetTimer = emittedReadyResetTimers.get(surface);
  if (pendingResetTimer !== undefined) {
    window.clearTimeout(pendingResetTimer);
    emittedReadyResetTimers.delete(surface);
  }
}

/**
 * Clear the shared `ui.ready` dedupe state for a renderer surface.
 *
 * Used by the shared bootstrap cleanup path so a real same-surface rebootstrap
 * can emit `ui.ready` again immediately, without waiting for the deferred
 * StrictMode reset timer to fire.
 * @param surface - Surface whose ready-dedupe state should be cleared.
 */
export function resetReadySurface(surface: UiReadyEvent['surface']): void {
  cancelReadySurfaceReset(surface);
  emittedReadySurfaces.delete(surface);
}

/**
 * Emit `ui.ready` once per surface, with StrictMode-safe deduplication.
 *
 * Shared between the main shell and tray surface so both emit the lifecycle
 * event symmetrically.
 * @param props - Surface identifier to emit.
 * @returns `null` — this component renders no DOM.
 */
function SurfaceReadyEmitter({ surface }: Pick<AppProps, 'surface'>): null {
  const bus = useBus();

  useEffect(() => {
    cancelReadySurfaceReset(surface);

    if (emittedReadySurfaces.has(surface)) {
      return () => {
        const resetTimer = window.setTimeout(() => {
          resetReadySurface(surface);
        }, 0);
        emittedReadyResetTimers.set(surface, resetTimer);
      };
    }

    emittedReadySurfaces.add(surface);
    void bus.emit(UiSubjects.ready, { surface, timestamp: Date.now() });

    return () => {
      const resetTimer = window.setTimeout(() => {
        resetReadySurface(surface);
      }, 0);
      emittedReadyResetTimers.set(surface, resetTimer);
    };
  }, [bus, surface]);

  return null;
}

/**
 * App - Root component for shared host renderer surfaces.
 *
 * Routes to {@link LazyTrayView} (code-split) when `surface === 'tray'`,
 * otherwise renders the full extension browser loader. Both branches emit
 * `ui.ready` via {@link SurfaceReadyEmitter}.
 * @param props - App configuration.
 * @returns Root application component.
 */
export function App({ bus, surface }: AppProps): JSX.Element {
  return (
    <BusProvider bus={bus}>
      <SurfaceReadyEmitter surface={surface} />
      {surface === 'tray' ? (
        <Suspense fallback={null}>
          <LazyTrayView />
        </Suspense>
      ) : (
        <ExtensionBrowserLoader />
      )}
    </BusProvider>
  );
}

import { MakaioBus } from '@makaio/bus-core';
import { loadWindowSession, resolveInitialCustomData, resolveInitialWindowState } from '@makaio/host-shared';
import type { CreateWindowOptions, WindowManager } from './window-manager.js';

export interface OpenInitialWindowsOptions {
  /** Host window creation helper. */
  createWindow: (options: CreateWindowOptions) => number;
  /** Fallback shell window opener. */
  openDefaultWindow: () => number;
  /** Session scope used for persistence. */
  sessionScope: string;
  /** Active Electrobun window manager. */
  windowManager: WindowManager;
}

/**
 * Open the initial window(s) at startup.
 *
 * Priority:
 * 1. `MAKAIO_INITIAL_WINDOW` env override (integration tests, CLI launch).
 * 2. Persisted window session restore.
 * 3. Fallback framework shell window (`framework-shell:main`).
 * @param options - Window/session dependencies for startup restore.
 */
export async function openInitialWindows(options: OpenInitialWindowsOptions): Promise<void> {
  const { createWindow, openDefaultWindow, sessionScope, windowManager } = options;
  const { registrationId, isOverride } = resolveInitialWindowState();

  if (isOverride) {
    // Environment-driven override (integration tests, CLI launch).
    const customData = resolveInitialCustomData();
    createWindow({
      registrationId,
      params: Object.keys(customData).length > 0 ? customData : undefined,
    });
    return;
  }

  let session: Awaited<ReturnType<typeof loadWindowSession>> = null;
  try {
    session = await loadWindowSession(MakaioBus, sessionScope);
  } catch (err: unknown) {
    console.warn('[electrobun] Failed to load window session:', err);
  }

  if (!session) {
    // No session to restore — open the fallback framework shell window.
    openDefaultWindow();
    return;
  }

  for (const entry of session.windows) {
    try {
      createWindow({
        registrationId: entry.registrationId,
        params: entry.params,
      });
      // Note: Electrobun does not expose `screen.getDisplayMatching()` so
      // bound restoration is skipped. The OS will position windows using its
      // default placement strategy.
    } catch (err: unknown) {
      console.warn('[electrobun] Failed to restore window (registrationId=%s):', entry.registrationId, err);
    }
  }

  // When a stale session contains only removed/renamed registration IDs,
  // every createWindow call above fails silently. Fall back to the default
  // window so the user always sees at least one window on startup.
  if (windowManager.listWindows().length === 0) {
    openDefaultWindow();
  }
}

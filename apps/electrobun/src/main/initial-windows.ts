import { MakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/contracts';
import { loadWindowSession, resolveInitialCustomData, resolveInitialWindowState } from '@makaio/host-shared';
import type { CreateWindowOptions, WindowManager } from './window-manager.js';

export interface OpenInitialWindowsOptions {
  /**
   * Host window creation helper.
   * @param call - Call for the startup window operation.
   * @param options - Window creation options forwarded to WindowManager.
   */
  createWindow: (call: CallContext, options: CreateWindowOptions) => number;
  /**
   * Fallback shell window opener.
   * @param call - Call for the startup window operation.
   */
  openDefaultWindow: (call: CallContext) => number;
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
 * 3. Fallback shell window (`framework-shell:main`).
 * @param call - Call for startup session restore and window creation.
 * @param options - Window/session dependencies for startup restore.
 */
export async function openInitialWindows(call: CallContext, options: OpenInitialWindowsOptions): Promise<void> {
  const { createWindow, openDefaultWindow, sessionScope, windowManager } = options;
  const { registrationId, isOverride } = resolveInitialWindowState();

  if (isOverride) {
    // Environment-driven override (integration tests, CLI launch).
    const customData = resolveInitialCustomData();
    createWindow(call, {
      registrationId,
      params: Object.keys(customData).length > 0 ? customData : undefined,
    });
    return;
  }

  let session: Awaited<ReturnType<typeof loadWindowSession>> = null;
  try {
    session = await loadWindowSession(call, MakaioBus, sessionScope);
  } catch (err: unknown) {
    console.warn('[electrobun] Failed to load window session:', err);
  }

  if (!session) {
    // No session to restore — open the fallback shell window.
    openDefaultWindow(call);
    return;
  }

  for (const entry of session.windows) {
    try {
      createWindow(call, {
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
    openDefaultWindow(call);
  }
}

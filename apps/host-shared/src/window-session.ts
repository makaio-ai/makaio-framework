/**
 * Shared window-session persistence for desktop hosts.
 *
 * Persists the full set of open windows to the preferences service before
 * shutdown and restores them on startup. The storage key is host-scoped so
 * Electron and Electrobun do not overwrite each other's sessions.
 */

import { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import { PreferencesSchemas, PreferencesSubjects, type PreferenceKey } from '@makaio/services-core/preferences';
/**
 * Canonical serializable window-manager snapshot shared by desktop hosts.
 *
 * Defined here so the shared persistence layer has no dependency on a specific
 * host package. Each host's `WindowManager.toState()` produces this shape.
 */
export interface WindowManagerState {
  /** Unique window identifier assigned by the host runtime. */
  readonly windowId: number;
  /** Qualified window registration ID: `{packageName}:{windowId}`. */
  readonly registrationId: string;
  /** Context parameters associated with the window. */
  readonly params?: Record<string, string>;
  /** Display label (project name, chat preview, or window title). */
  readonly label?: string;
  /** Whether the window is currently visible. */
  readonly visible: boolean;
  /** Whether the window is currently focused. */
  readonly focused: boolean;
}

/**
 * Host scope written into the preferences key for the window session.
 *
 * This keeps persisted sessions isolated per desktop host.
 */
export type WindowSessionScope = PreferenceKey['scope'];

/**
 * PreferencesService category used to store the window session.
 */
const WINDOW_SESSION_CATEGORY = 'window-session';

/**
 * Minimal bus client surface needed for window session persistence.
 */
export type WindowSessionBusClient = Pick<IMakaioBus, 'request'>;

/**
 * Minimal window registry surface needed to snapshot and restore windows.
 */
export interface WindowSessionWindowSource {
  listWindows(): ReadonlyArray<WindowManagerState>;
  getWindow(windowId: number): Readonly<WindowSessionWindowEntry> | undefined;
}

/**
 * Serializable window bounds captured during persistence.
 */
export interface WindowSessionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Minimal live window surface needed during persistence.
 */
export interface WindowSessionLiveWindow {
  isDestroyed(): boolean;
  getBounds(): WindowSessionBounds;
}

/**
 * Minimal live window entry shape needed during persistence.
 */
export interface WindowSessionWindowEntry {
  readonly registrationId: WindowManagerState['registrationId'];
  readonly params?: Record<string, string>;
  readonly win: WindowSessionLiveWindow;
}

const PersistedBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const PersistedWindowEntrySchema = z.object({
  registrationId: z.string().regex(/^[^:]+:[^:]+$/, 'registrationId must be {packageName}:{windowId}'),
  params: z.record(z.string(), z.string()).optional(),
  bounds: PersistedBoundsSchema,
});

const PersistedWindowSessionSchema = z.object({
  version: z.literal(1),
  windows: z.array(PersistedWindowEntrySchema).min(1),
});

/**
 * Single window entry stored in the session.
 */
export type PersistedWindowEntry = z.infer<typeof PersistedWindowEntrySchema>;

/**
 * The full window session payload stored in preferences.
 */
export type PersistedWindowSession = z.infer<typeof PersistedWindowSessionSchema>;

/**
 * Capture the current open windows and write them to the PreferencesService.
 * @param busClient - Connected bus client used to reach the PreferencesService.
 * @param windowManager - Live window manager whose registry is snapshotted.
 * @param hostScope - Host-specific preference scope such as `electron`.
 */
export async function saveWindowSession(
  busClient: WindowSessionBusClient,
  windowManager: WindowSessionWindowSource,
  hostScope: WindowSessionScope,
): Promise<void> {
  const snapshots = windowManager.listWindows();

  const entries: PersistedWindowEntry[] = [];
  for (const snapshot of snapshots) {
    const entry = windowManager.getWindow(snapshot.windowId);
    if (entry == null || entry.win.isDestroyed()) {
      continue;
    }

    const bounds = entry.win.getBounds();
    if (bounds.width <= 0 || bounds.height <= 0) {
      continue;
    }

    entries.push({
      registrationId: snapshot.registrationId,
      ...(snapshot.params != null ? { params: snapshot.params } : {}),
      bounds,
    });
  }

  if (entries.length === 0) {
    await deleteWindowSession(busClient, hostScope);
    return;
  }

  const response = await busClient.request(PreferencesSubjects.set, {
    key: createWindowSessionKey(hostScope),
    category: WINDOW_SESSION_CATEGORY,
    value: { version: 1, windows: entries } satisfies PersistedWindowSession,
  });

  const parsedResponse = PreferencesSchemas.set.response.safeParse(response);
  if (!parsedResponse.success) {
    throw new Error(`Invalid preferences.set response while saving window session: ${parsedResponse.error.message}`);
  }
}

/**
 * Load and validate the previously saved window session from the PreferencesService.
 * @param busClient - Connected bus client used to reach the PreferencesService.
 * @param hostScope - Host-specific preference scope such as `electron`.
 * @returns Validated session, or `null` when missing/invalid.
 */
export async function loadWindowSession(
  busClient: WindowSessionBusClient,
  hostScope: WindowSessionScope,
): Promise<PersistedWindowSession | null> {
  let response: unknown;
  try {
    response = await busClient.request(PreferencesSubjects.get, {
      key: createWindowSessionKey(hostScope),
      category: WINDOW_SESSION_CATEGORY,
    });
  } catch (err: unknown) {
    console.warn('[WindowSession] Failed to load window session from preferences:', err);
    return null;
  }

  const responseResult = PreferencesSchemas.get.response.safeParse(response);
  if (!responseResult.success) {
    console.warn('[WindowSession] Unexpected preferences.get response shape:', responseResult.error.message);
    return null;
  }

  if (responseResult.data.value == null) {
    return null;
  }

  const sessionResult = PersistedWindowSessionSchema.safeParse(responseResult.data.value);
  if (!sessionResult.success) {
    console.warn('[WindowSession] Stored session failed validation (stale data?):', sessionResult.error.message);
    return null;
  }

  return sessionResult.data;
}

/**
 * Remove the stored window session from the PreferencesService.
 * @param busClient - Connected bus client used to reach the PreferencesService.
 * @param hostScope - Host-specific preference scope such as `electron`.
 */
async function deleteWindowSession(busClient: WindowSessionBusClient, hostScope: WindowSessionScope): Promise<void> {
  const response = await busClient.request(PreferencesSubjects.delete, {
    key: createWindowSessionKey(hostScope),
    category: WINDOW_SESSION_CATEGORY,
  });

  const parsedResponse = PreferencesSchemas.delete.response.safeParse(response);
  if (!parsedResponse.success) {
    throw new Error(
      `Invalid preferences.delete response while clearing window session: ${parsedResponse.error.message}`,
    );
  }
}

/**
 * Build the host-scoped preference key for window-session persistence.
 * @param hostScope - Host-specific preference scope such as `electron`.
 * @returns Preferences key scoped to the current host.
 */
function createWindowSessionKey(hostScope: WindowSessionScope): PreferenceKey {
  return { scope: hostScope };
}

/**
 * User-configurable CWD change notification preference and its resolution.
 *
 * Used by message routing to inject a working-directory-change note into
 * agent context after a connector swap moved the session to a new cwd.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { PreferencesSubjects } from '../../preferences/storage-namespace.js';

/**
 * User-configurable CWD change notification preference.
 *
 * Stored under category `'chat-display'` with context key `'cwdChangeNotification'`.
 */
export interface CwdChangeNotificationPreference {
  /** Whether to inject a CWD change message into agent context at all. */
  enabled: boolean;
  /**
   * Message template. Supports `{oldCwd}` and `{newCwd}` placeholders
   * which are replaced with the actual directory paths at routing time.
   */
  template: string;
}

/** Preference category shared with other chat display settings. */
const CWD_CHANGE_PREF_CATEGORY = 'chat-display';

/** Preference context key within the category. */
const CWD_CHANGE_PREF_KEY = 'cwdChangeNotification';

/** Default notification config when no preference is stored. */
export const DEFAULT_CWD_CHANGE_NOTIFICATION: CwdChangeNotificationPreference = {
  enabled: true,
  template: 'User changed working directory from {oldCwd} to {newCwd}',
};

/**
 * Interpolate `{oldCwd}` and `{newCwd}` placeholders in a CWD change message template.
 * @param template - Template string with optional placeholders
 * @param oldCwd - Previous working directory path
 * @param newCwd - New working directory path
 * @returns Interpolated message string
 */
export function applyCwdChangeTemplate(template: string, oldCwd: string, newCwd: string): string {
  return template.replace(/\{oldCwd\}/g, oldCwd).replace(/\{newCwd\}/g, newCwd);
}

/**
 * Runtime guard for CWD notification preferences loaded from untyped storage.
 * @param value - Unknown stored preference value
 * @returns True when the value matches CwdChangeNotificationPreference
 */
function isCwdChangeNotificationPreference(value: unknown): value is CwdChangeNotificationPreference {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.enabled === 'boolean' && typeof record.template === 'string';
}

/**
 * Read the CWD change notification preference via bus, falling back to the default.
 * @param bus - Bus instance for preferences lookup
 * @returns Resolved preference (never throws; falls back to default on error)
 */
export async function readCwdChangeNotificationPref(bus: IMakaioBus): Promise<CwdChangeNotificationPreference> {
  try {
    const result = await bus.request(PreferencesSubjects.get, {
      key: { scope: 'global', surface: 'ui', context: CWD_CHANGE_PREF_KEY },
      category: CWD_CHANGE_PREF_CATEGORY,
    });
    if (result.value !== null && result.value !== undefined) {
      if (isCwdChangeNotificationPreference(result.value)) {
        return result.value;
      }
      // Stored value is malformed for this key; use safe default.
      return DEFAULT_CWD_CHANGE_NOTIFICATION;
    }
  } catch {
    // PreferencesService unavailable — fall back to default
  }
  return DEFAULT_CWD_CHANGE_NOTIFICATION;
}

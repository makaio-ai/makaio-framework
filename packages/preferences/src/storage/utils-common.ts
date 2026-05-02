import type { PreferenceKey } from '@makaio/services-core/preferences';
import type { StoredPreference } from './types.js';

/**
 * Row key values for database storage.
 * All optional fields are stored as 'any' when undefined.
 */
export interface RowKey {
  scope: string;
  surface: string;
  context: string;
  viewport: string;
}

/**
 * Convert PreferenceKey to row values (handling undefined to 'any').
 * @param key - The preference key
 * @returns Row values with 'any' defaults
 */
export function keyToRow(key: PreferenceKey): RowKey {
  return {
    scope: key.scope,
    surface: key.surface ?? 'any',
    context: key.context ?? 'any',
    viewport: key.viewport ?? 'any',
  };
}

/**
 * Convert row values back to PreferenceKey (handling 'any' to undefined).
 * @param row - Row values from database
 * @returns PreferenceKey with undefined for 'any' values
 */
export function rowToKey(row: RowKey): PreferenceKey {
  return {
    scope: row.scope,
    surface: row.surface === 'any' ? undefined : (row.surface as 'ui' | 'app'),
    context: row.context === 'any' ? undefined : row.context,
    viewport: row.viewport === 'any' ? undefined : (row.viewport as 'desktop' | 'tablet' | 'mobile'),
  };
}

/**
 * Generates stable localStorage key from preference components.
 * Format: `makaio:prefs:scope:surface:context:viewport:category`
 * @param key - Preference key
 * @param category - Preference category
 * @returns Stable string key
 */
export function getStorageKey(key: PreferenceKey, category: string): string {
  const parts = [
    'makaio:prefs',
    key.scope,
    key.surface || 'any',
    key.context || 'any',
    key.viewport || 'any',
    category,
  ];
  return parts.join(':');
}

/**
 * Parses localStorage key back into components.
 * @param storageKey - The localStorage key
 * @returns Parsed components or null if invalid
 */
export function parseStorageKey(storageKey: string): { key: PreferenceKey; category: string } | null {
  if (!storageKey.startsWith('makaio:prefs:')) {
    return null;
  }

  const parts = storageKey.split(':');
  // Expected format: makaio:prefs:scope:surface:context:viewport:category
  // Split by ':' gives: ['makaio', 'prefs', scope, surface, context, viewport, category]
  // So we need at least 7 parts
  if (parts.length < 7 || parts[0] !== 'makaio' || parts[1] !== 'prefs') {
    return null;
  }

  const [, , /* makaio */ /* prefs */ scope, surface, context, viewport, ...categoryParts] = parts;
  const category = categoryParts.join(':');

  return {
    key: {
      scope,
      surface: surface === 'any' ? undefined : (surface as 'ui' | 'app'),
      context: context === 'any' ? undefined : context,
      viewport: viewport === 'any' ? undefined : (viewport as 'desktop' | 'tablet' | 'mobile'),
    },
    category,
  };
}

/**
 * Type guard for StoredPreference validation.
 * @param value - Value to check
 * @returns True if valid StoredPreference
 */
export function isStoredPreference(value: unknown): value is StoredPreference {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'updatedAt' in value &&
    typeof (value as StoredPreference).value === 'string' &&
    typeof (value as StoredPreference).updatedAt === 'number'
  );
}

/**
 * Parses a localStorage entry into StoredPreference format.
 * Legacy entries (raw JSON values) are wrapped with updatedAt: 0.
 * @param raw - Raw localStorage string
 * @returns StoredPreference or null if JSON is invalid
 */
export function parseStoredPreference(raw: string): StoredPreference | null {
  try {
    const parsed = JSON.parse(raw);

    if (isStoredPreference(parsed)) {
      return parsed;
    }

    return {
      value: JSON.stringify(parsed),
      updatedAt: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Shared onboarding skip-flag helpers.
 *
 * Centralizes localStorage access so the first-run gate and onboarding flow
 * completion use the same persistence contract.
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Internal localStorage helpers
// ---------------------------------------------------------------------------

/**
 * Read a boolean flag from localStorage.
 * Storage failures are treated as `false`.
 * @param key - localStorage key to read.
 * @returns `true` when the stored value is the string `'true'`.
 */
function readBooleanFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/**
 * Write `'true'` to a localStorage key.
 * Storage failures are intentionally ignored so callers can still continue.
 * @param key - localStorage key to set.
 */
function writeTrueFlag(key: string): void {
  try {
    localStorage.setItem(key, 'true');
  } catch {
    // Storage may be unavailable in private/restricted contexts.
  }
}

/**
 * Remove a key from localStorage.
 * Storage failures are intentionally ignored so callers can still continue.
 * @param key - localStorage key to remove.
 */
function clearFlag(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in private/restricted contexts.
  }
}

// ---------------------------------------------------------------------------
// Onboarding skipped flag
// ---------------------------------------------------------------------------

const ONBOARDING_SKIPPED_KEY = 'makaio-onboarding-skipped';

/**
 * Read the persisted onboarding skip flag.
 * Storage failures are treated as "not skipped".
 * @returns True when onboarding has been skipped in this browser profile
 */
export function getOnboardingSkipped(): boolean {
  return readBooleanFlag(ONBOARDING_SKIPPED_KEY);
}

/**
 * Persist the onboarding skip flag.
 * Storage failures are intentionally ignored so callers can still continue.
 */
export function setOnboardingSkipped(): void {
  writeTrueFlag(ONBOARDING_SKIPPED_KEY);
}

/**
 * Clear the onboarding skip flag.
 * Storage failures are intentionally ignored so callers can still continue.
 */
export function clearOnboardingSkipped(): void {
  clearFlag(ONBOARDING_SKIPPED_KEY);
}

// ---------------------------------------------------------------------------
// Onboarding completed flag
// ---------------------------------------------------------------------------

const ONBOARDING_COMPLETED_KEY = 'makaio-onboarding-completed';

/**
 * Check whether onboarding has been completed.
 * @returns True when the completed flag is set in localStorage
 */
export function getOnboardingCompleted(): boolean {
  return readBooleanFlag(ONBOARDING_COMPLETED_KEY);
}

/** Mark onboarding as completed persistently. */
export function setOnboardingCompleted(): void {
  writeTrueFlag(ONBOARDING_COMPLETED_KEY);
}

/** Clear the onboarding completed flag. */
export function clearOnboardingCompleted(): void {
  clearFlag(ONBOARDING_COMPLETED_KEY);
}

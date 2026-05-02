/**
 * Splash screen progress types shared between the Electron main process and
 * the electron-ui renderer. Defined in contracts so the renderer package can
 * import them without depending on any Node.js-specific code.
 */

/**
 * Progress state reported during startup polling.
 */
export type SplashProgressState = 'starting' | 'connecting' | 'loading' | 'error';

/**
 * Deterministic boot progress data, available once service boot begins.
 */
export interface SplashProgressData {
  /** Number of services that have completed (started or failed). */
  completed: number;
  /** Total number of services registered for this boot sequence. */
  total: number;
  /** Display name of the service currently starting, if known. */
  current?: string;
}

/**
 * Snapshot of the current polling progress, suitable for driving a
 * splash-screen UI.
 */
export interface SplashProgress {
  /** Current phase of the startup sequence. */
  state: SplashProgressState;
  /** Optional human-readable message for the current state. */
  message?: string;
  /**
   * Deterministic boot progress, present once boot events arrive over the bus.
   * When absent, the progress bar runs in indeterminate
   * mode (animated slide). When present, the bar fills deterministically.
   */
  progress?: SplashProgressData;
}

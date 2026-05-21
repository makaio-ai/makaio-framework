/** Foreground request sources with distinct Electron behavior. */
export type ElectronForegroundRequestKind = 'activate' | 'second-instance';

/** Coordinates pending foreground requests around Electron startup. */
export interface ElectronForegroundRequestController {
  /**
   * Queue or handle a foreground request from Electron.
   * @param kind - Foreground source to handle.
   */
  request(kind: ElectronForegroundRequestKind): void;
  /** Replay a queued foreground request once startup can own windows. */
  flush(): void;
}

/** Dependencies used by the foreground request controller. */
export interface ElectronForegroundRequestControllerOptions {
  /** Whether startup has finished and window management is ready. */
  isReady: () => boolean;
  /** Whether Electron currently has any native BrowserWindow instances. */
  hasOpenWindows: () => boolean;
  /** Focus the most appropriate existing window. */
  focusWindow: () => boolean;
  /** Open the fallback framework shell window. */
  openDefaultWindow: () => void;
  /** Restore visible desktop chrome after background startup. */
  restoreFromBackgroundMode: () => void;
}

/**
 * Create the foreground request coordinator used by Electron OS lifecycle
 * events.
 * @param options - Callbacks that bridge the controller to Electron runtime
 * state.
 * @returns Controller that queues pre-startup requests and replays them when
 * startup is ready.
 */
export function createElectronForegroundRequestController(
  options: ElectronForegroundRequestControllerOptions,
): ElectronForegroundRequestController {
  let pendingRequest: ElectronForegroundRequestKind | null = null;

  /**
   * Store the strongest pending foreground request.
   * @param kind - Foreground request source received before startup is ready.
   */
  function remember(kind: ElectronForegroundRequestKind): void {
    // Pre-ready foreground requests coalesce to one replay: both actions only
    // mean "bring the app forward", with second-instance requiring focus/open.
    pendingRequest = kind === 'second-instance' || pendingRequest === null ? kind : pendingRequest;
  }

  /**
   * Execute a foreground request against ready window management.
   * @param kind - Foreground request source to replay or handle immediately.
   */
  function handle(kind: ElectronForegroundRequestKind): void {
    if (kind === 'activate') {
      if (!options.hasOpenWindows()) options.openDefaultWindow();
      return;
    }

    if (!options.focusWindow()) options.openDefaultWindow();
  }

  return {
    request(kind) {
      options.restoreFromBackgroundMode();
      if (!options.isReady()) {
        remember(kind);
        return;
      }
      handle(kind);
    },
    flush() {
      if (!options.isReady() || pendingRequest === null) return;
      const kind = pendingRequest;
      pendingRequest = null;
      handle(kind);
    },
  };
}

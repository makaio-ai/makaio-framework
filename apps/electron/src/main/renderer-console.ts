/**
 * Canonical renderer console severity labels derived from Electron's
 * deprecated numeric `console-message` level argument.
 */
export type RendererConsoleSeverity = 'verbose' | 'info' | 'warning' | 'error';

/**
 * Main-process console methods used to surface renderer logs.
 */
export type RendererConsoleMethod = 'info' | 'warn' | 'error';

/**
 * Format of a renderer console message after severity normalization.
 */
export interface RendererConsoleEvent {
  /** Renderer severity label derived from Electron's numeric level. */
  readonly severity: RendererConsoleSeverity;
  /** Main-process console method used for this renderer event. */
  readonly method: RendererConsoleMethod;
  /** Human-readable log line for the main-process console. */
  readonly text: string;
}

/**
 * Normalize Electron renderer console messages into stable severities and
 * matching main-process console methods.
 *
 * Electron documents deprecated numeric levels as:
 * 0 = verbose, 1 = info, 2 = warning, 3 = error.
 * Unknown values are treated as `info` so renderer logs remain observable
 * without introducing speculative severity handling.
 * @param level - Deprecated numeric level from `webContents` `console-message`.
 * @param message - Renderer console message text.
 * @param line - Source line reported by Electron.
 * @param sourceId - Source URL or file identifier reported by Electron.
 * @returns Normalized renderer console event details.
 */
export function createRendererConsoleEvent(
  level: number,
  message: string,
  line: number,
  sourceId: string,
): RendererConsoleEvent {
  const severity = toRendererConsoleSeverity(level);
  return {
    severity,
    method: toRendererConsoleMethod(severity),
    text: `[Renderer:${severity}] ${message} (${sourceId}:${line})`,
  };
}

/**
 * Map Electron's deprecated numeric level to a stable renderer severity label.
 * @param level - Deprecated numeric level from `webContents` `console-message`.
 * @returns Normalized renderer severity label.
 */
function toRendererConsoleSeverity(level: number): RendererConsoleSeverity {
  switch (level) {
    case 0:
      return 'verbose';
    case 2:
      return 'warning';
    case 3:
      return 'error';
    case 1:
    default:
      return 'info';
  }
}

/**
 * Map a normalized renderer severity to the matching main-process console method.
 * @param severity - Renderer severity label.
 * @returns Console method used to surface the renderer message.
 */
function toRendererConsoleMethod(severity: RendererConsoleSeverity): RendererConsoleMethod {
  switch (severity) {
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
    case 'verbose':
    case 'info':
    default:
      return 'info';
  }
}

/**
 * Emit a normalized renderer console event through the appropriate main-process console.
 * @param event - Normalized renderer console event.
 * @returns Nothing.
 */
export function logRendererConsoleEvent(event: RendererConsoleEvent): void {
  switch (event.method) {
    case 'warn':
      console.warn(event.text);
      return;
    case 'error':
      console.error(event.text);
      return;
    case 'info':
    default:
      console.info(event.text);
  }
}

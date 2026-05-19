/**
 * Host-owned restart handler for the Electron surface.
 */

/**
 * Minimal Electron app lifecycle API used by the restart handler.
 */
export interface ElectronRestartApp {
  /** Relaunch the app after the current process exits. */
  relaunch(): void;
  /** Trigger Electron's normal quit path. */
  quit(): void;
}

/**
 * Creates a `kernel.restart` handler for Electron.
 * @param options - Restart dependencies.
 * @returns Bus handler that accepts restart and schedules Electron relaunch.
 */
export function createElectronRestartHandler(options: {
  /** Electron app instance. */
  readonly app: ElectronRestartApp;
  /** Optional scheduler, defaults to next-tick timeout. */
  readonly schedule?: (task: () => void) => void;
}) {
  const { app, schedule = (task) => setTimeout(task, 0) } = options;
  let scheduled = false;
  return (ctx: { setResult: (result: { accepted: boolean }) => void }) => {
    ctx.setResult({ accepted: true });
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      app.relaunch();
      app.quit();
    });
  };
}

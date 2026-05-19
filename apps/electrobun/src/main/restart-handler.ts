/**
 * Host-owned restart handler for the Electrobun surface.
 */

/** Result returned to callers of the kernel restart RPC. */
type KernelRestartResult = { readonly accepted: boolean };

/** Request context shape used by the restart handler. */
type KernelRestartContext = { readonly setResult: (result: KernelRestartResult) => void };

/** Dependencies required to relaunch the Electrobun host. */
interface ElectrobunRestartHandlerOptions {
  /** Starts a replacement app process. */
  readonly relaunch: () => void;
  /** Shuts down the current process through the normal host path. */
  readonly shutdown: () => void;
  /** Optional scheduler, defaults to next-tick timeout. */
  readonly schedule?: (task: () => void) => void;
}

/**
 * Creates a `kernel.restart` handler for Electrobun.
 * @param options - Restart dependencies.
 * @returns Bus handler that accepts restart and schedules relaunch + shutdown.
 */
export function createElectrobunRestartHandler(options: ElectrobunRestartHandlerOptions) {
  const { relaunch, shutdown, schedule = (task) => setTimeout(task, 0) } = options;
  let scheduled = false;
  return (ctx: KernelRestartContext) => {
    ctx.setResult({ accepted: true });
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      relaunch();
      shutdown();
    });
  };
}

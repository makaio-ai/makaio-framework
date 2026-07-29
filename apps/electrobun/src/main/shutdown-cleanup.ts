/**
 * Run one shutdown operation while preserving its failure for aggregate
 * reporting and allowing the remaining cleanup operations to continue.
 * @param failures - Mutable collection of shutdown failures.
 * @param onFailure - Logger for the operation-specific failure context.
 * @param cleanup - Synchronous or asynchronous cleanup operation.
 */
async function collectShutdownFailure(
  failures: unknown[],
  onFailure: (error: unknown) => void,
  cleanup: () => void | Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error: unknown) {
    failures.push(error);
    onFailure(error);
  }
}

/**
 * Complete every Electrobun teardown operation and report all failures after
 * cleanup has finished.
 * @param options - Shutdown operations owned by the composition root.
 */
export async function shutdownElectrobun(options: {
  saveWindowSession: (() => Promise<void>) | null;
  closeWindows: (() => void) | null;
  shutdownRuntime: () => Promise<void>;
  busHandlerCleanups: readonly (() => void)[];
  destroyTray: (() => void) | null;
  closeVite: (() => Promise<void>) | null;
}): Promise<void> {
  const failures: unknown[] = [];
  if (options.saveWindowSession) {
    await collectShutdownFailure(
      failures,
      (error) => console.warn('[electrobun] Failed to save window session:', error),
      options.saveWindowSession,
    );
  }
  if (options.closeWindows) {
    await collectShutdownFailure(
      failures,
      (error) => console.warn('[electrobun] Failed to close windows during shutdown:', error),
      options.closeWindows,
    );
  }
  await collectShutdownFailure(
    failures,
    (error) => console.error('[electrobun] Runtime shutdown did not complete cleanly:', error),
    options.shutdownRuntime,
  );
  for (const cleanup of options.busHandlerCleanups) {
    await collectShutdownFailure(
      failures,
      (error) => console.warn('[electrobun] Bus handler cleanup error:', error),
      cleanup,
    );
  }
  if (options.destroyTray) {
    await collectShutdownFailure(
      failures,
      (error) => console.warn('[electrobun] Tray teardown error:', error),
      options.destroyTray,
    );
  }
  if (options.closeVite) {
    await collectShutdownFailure(
      failures,
      (error) => console.warn('[electrobun] Vite close error:', error),
      options.closeVite,
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Electrobun shutdown completed with ${failures.length} cleanup failure(s)`);
  }
}

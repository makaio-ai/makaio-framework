/**
 * Environment variables through which the serve signal E2E tests steer the
 * fixture in `serve-signal-entry.ts`. Kept apart from the entry, which runs
 * the CLI as soon as it is imported.
 */

/** Names the file the fixture child appends its PID to. */
export const CHILD_PID_FILE_ENV = 'SIGNAL_FIXTURE_CHILD_PID_FILE';
/** Milliseconds `destroy()` of the child extension waits before it stops the child. */
export const DESTROY_DELAY_ENV = 'SIGNAL_FIXTURE_DESTROY_DELAY_MS';
/** Milliseconds the slow-start extension takes to initialise. */
export const SLOW_START_ENV = 'SIGNAL_FIXTURE_SLOW_START_MS';
/** When `1`, `destroy()` of the child extension stops the child and then rejects. */
export const DESTROY_FAIL_ENV = 'SIGNAL_FIXTURE_DESTROY_FAIL';
/** When `1`, the slow-start extension is critical and fails its initialisation, which fails the boot. */
export const SLOW_START_FAIL_ENV = 'SIGNAL_FIXTURE_SLOW_START_FAIL';
/**
 * When set, the fixture children ignore `SIGTERM` and their owner gives the
 * graceful stage of their stop this many milliseconds, so a stop takes that
 * long before it escalates to `SIGKILL`.
 */
export const STUBBORN_KILL_GRACE_ENV = 'SIGNAL_FIXTURE_STUBBORN_KILL_GRACE_MS';
/** When `1`, a second extension owns a second child, which a stop reaches before the first one's. */
export const SECOND_CHILD_ENV = 'SIGNAL_FIXTURE_SECOND_CHILD';
/** When `1`, `destroy()` of the second child extension never settles. */
export const SECOND_DESTROY_HANG_ENV = 'SIGNAL_FIXTURE_SECOND_DESTROY_HANG';
/** Stop window, in milliseconds, the hanging second child extension declares; the default window when unset. */
export const SECOND_STOP_BUDGET_ENV = 'SIGNAL_FIXTURE_SECOND_STOP_BUDGET_MS';
/**
 * When `1`, a handler of the boot's first phase event never settles, so the boot
 * is held in a phase that never reaches a checkpoint.
 */
export const BOOT_HANG_ENV = 'SIGNAL_FIXTURE_BOOT_HANG';
/**
 * When set, a detached `bus-websocket` extension is started whose child never
 * becomes ready; this is its health timeout in milliseconds, i.e. how long its
 * start would wait if nothing cancelled it. The child records its PID like the
 * other fixture children.
 */
export const DETACHED_NEVER_READY_HEALTH_ENV = 'SIGNAL_FIXTURE_DETACHED_NEVER_READY_HEALTH_MS';

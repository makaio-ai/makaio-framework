/**
 * E2E bus test helpers for CLI serve tests.
 *
 * Re-exports the shared implementation from `e2e/shared/bus-helpers`.
 */

export type { ConnectTestBusOptions, BootPayload, RuntimeReadyPayload } from '../../../../e2e/shared/bus-helpers.js';
export { connectTestBus, waitForBoot, waitForRuntimeReady } from '../../../../e2e/shared/bus-helpers.js';

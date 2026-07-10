/**
 * Bounded window (in milliseconds) in which an active transport or SDK query
 * may deliver its terminal result during teardown.
 *
 * Both the Agent SDK and CLI adapters use this value to race a drain promise
 * against a timeout before force-completing an interrupted turn. Shared here
 * so the two implementations stay in sync without duplicating the magic number.
 */
export const TERMINAL_RESULT_DRAIN_TIMEOUT_MS = 250;

/**
 * Sink for internal bus diagnostics (one formatted line per call).
 */
export type BusDebugLog = (message: string) => void;

/**
 * Default sink. Resolves `console.debug` at call time (not at module load) so
 * spies installed later still intercept the output and browser visibility is unchanged.
 * @param message - Diagnostic line
 */
const defaultBusDebugLog: BusDebugLog = (message) => {
  console.debug(message);
};

/**
 * Wrap a diagnostic sink so it can never change caller state.
 *
 * A diagnostic sink is observational only: a synchronous throw or a rejected
 * thenable returned by the callback (assignable to the `void`-returning type) is
 * swallowed instead of failing propagation, sync, or dispatch. The failure is
 * dropped deliberately: there is no safe channel to report it on (stdout may be a
 * protocol channel, and reporting through the same sink would recurse).
 * @param sink - Sink to wrap
 * @returns Sink that never throws and never leaves an unhandled rejection
 */
export function toSafeDebugLog(sink: BusDebugLog): BusDebugLog {
  return (message) => {
    try {
      const result: unknown = sink(message);
      if (result !== null && result !== undefined && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // Diagnostic sink failures must not affect caller state (see TSDoc).
    }
  };
}

/**
 * Resolve the bus's diagnostic sink: the caller-supplied one or the `console.debug`
 * default, wrapped by {@link toSafeDebugLog}.
 * @param sink - Caller-supplied sink; omit for the `console.debug` default
 * @returns Sink that never throws and never leaves an unhandled rejection
 */
export function resolveBusDebugLog(sink?: BusDebugLog): BusDebugLog {
  return toSafeDebugLog(sink ?? defaultBusDebugLog);
}

/**
 * Placeholder emitted when a value cannot be rendered at all.
 */
const UNFORMATTABLE = '[unformattable]';

/**
 * Render one diagnostic value as text; total, never throws.
 * @param value - Any value, including errors, circular structures, and hostile getters
 * @returns Text form of the value, or a fixed placeholder when rendering throws
 */
function formatValue(value: unknown): string {
  try {
    if (value instanceof Error) return value.message === '' ? value.name : `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return UNFORMATTABLE;
    }
  }
}

/**
 * Format a diagnostic message and its details into a single line.
 *
 * Browser-safe (no `node:util`); never throws, including for circular or hostile values.
 * @param message - Diagnostic headline
 * @param details - Named values appended as `key=value` pairs
 * @returns One-line text, e.g. `[Tag] text transport=ws error=Error: boom`
 */
export function formatBusDiagnostic(message: string, details: Record<string, unknown>): string {
  try {
    const pairs = Object.entries(details).map(([key, value]) => `${key}=${formatValue(value)}`);
    return pairs.length === 0 ? message : `${message} ${pairs.join(' ')}`;
  } catch {
    return message;
  }
}

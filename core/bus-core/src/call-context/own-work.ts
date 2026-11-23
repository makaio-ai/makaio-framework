import type { OwnWorkPurpose, PartyRef } from '@makaio/core';

/**
 * Every purpose `bus.own(purpose)` accepts.
 *
 * Typed against `OwnWorkPurpose`, so a purpose added to or removed from the
 * core type fails the compile here until the list follows.
 */
export const OWN_WORK_PURPOSES = [
  'start',
  'stop',
  'schedule',
  'observer',
  'shared-work',
  'root',
] as const satisfies readonly OwnWorkPurpose[];

/**
 * Purposes that are declared to run alongside a handler of the same carrier.
 * A send with one of these never produces a report entry.
 */
export const CONCURRENT_OWN_WORK_PURPOSES: ReadonlySet<OwnWorkPurpose> = new Set<OwnWorkPurpose>([
  'schedule',
  'observer',
  'shared-work',
  'stop',
]);

/**
 * How a report entry is surfaced.
 *
 * - `off`: nothing is recorded.
 * - `count`: entries are recorded and readable through `getOwnCallReport()`; nothing is written.
 * - `warn`: like `count`, plus one `console.warn` per entry.
 */
export type OwnCallReportMode = 'off' | 'count' | 'warn';

/**
 * One reported send: an own context of a carrier used while the same carrier
 * had a handler call open, with a purpose that is not declared concurrent.
 */
export interface OwnCallReportEntry {
  readonly carrier: PartyRef;
  /**
   * Purpose the own context was obtained with. `undefined` for a send without
   * call: an own context without purpose and `own('root')` share one entry.
   */
  readonly purpose: OwnWorkPurpose | undefined;
  readonly subject: string;
  /** How often this carrier, purpose and subject combination was reported. */
  readonly occurrences: number;
}

/** Mode used when `MAKAIO_OWN_CALL_REPORT` is unset or not a known mode. */
const DEFAULT_MODE: OwnCallReportMode = 'count';

/** Open handler calls per carrier key. */
const openHandlerCalls = new Map<string, number>();

/** Report entries by carrier, purpose and subject; mutable internally, exposed read-only. */
const reportEntries = new Map<
  string,
  { carrier: PartyRef; purpose: OwnWorkPurpose | undefined; subject: string; occurrences: number }
>();

/** Entry keys that already produced a `console.warn`. */
const warnedEntries = new Set<string>();

/**
 * Build the carrier key from kind and id.
 * @param carrier - Carrier of the bus instance
 * @returns Stable map key
 */
function carrierKey(carrier: PartyRef): string {
  return JSON.stringify([carrier.kind, carrier.id]);
}

/**
 * Read the report mode from the environment. Read on every report so a test
 * can switch it without a restart.
 * @returns Active mode
 */
function readMode(): OwnCallReportMode {
  const value = process.env['MAKAIO_OWN_CALL_REPORT'];
  if (value === 'off' || value === 'count' || value === 'warn') return value;
  return DEFAULT_MODE;
}

/**
 * Whether a value is a thenable.
 * @param value - Value returned by a handler
 * @returns True when the value has a callable `then`
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Run a handler, interceptor or hook call and keep the carrier's open-call
 * counter raised until its result has settled (also when it throws or rejects).
 *
 * The result is returned unchanged; a promise is observed, not replaced.
 * @param carrier - Carrier that owns the handler
 * @param run - Invokes the handler and returns its result
 * @returns The result of `run`
 */
export function trackOpenHandlerCall<T>(carrier: PartyRef, run: () => T): T {
  const key = carrierKey(carrier);
  openHandlerCalls.set(key, (openHandlerCalls.get(key) ?? 0) + 1);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const open = (openHandlerCalls.get(key) ?? 0) - 1;
    if (open > 0) openHandlerCalls.set(key, open);
    else openHandlerCalls.delete(key);
  };

  let result: T;
  try {
    result = run();
  } catch (error) {
    release();
    throw error;
  }
  if (isThenable(result)) {
    // Observe only; the caller keeps the original promise and its rejection.
    result.then(release, release);
  } else {
    release();
  }
  return result;
}

/**
 * Number of handler calls of a carrier that have not settled yet.
 * @param carrier - Carrier to look up
 * @returns Open handler call count, 0 when none
 */
export function openHandlerCallCount(carrier: PartyRef): number {
  return openHandlerCalls.get(carrierKey(carrier)) ?? 0;
}

/**
 * Record a send whose call is an own context of the carrier.
 *
 * An own context without purpose and `own('root')` both mean "sent without
 * call"; they are normalised here to one entry with `purpose: undefined`.
 *
 * An entry is created only when the carrier has an open handler call and the
 * purpose is not in `CONCURRENT_OWN_WORK_PURPOSES`. Repeats of the same
 * carrier, purpose and subject raise `occurrences`; `warn` mode writes one
 * warning per entry.
 * @param carrier - Carrier whose own context was sent
 * @param purpose - Purpose the own context was obtained with, `undefined` when it has none
 * @param subject - Fully-qualified subject of the send
 */
export function noteOwnContextSend(carrier: PartyRef, purpose: OwnWorkPurpose | undefined, subject: string): void {
  const mode = readMode();
  if (mode === 'off') return;
  const reported = purpose === 'root' ? undefined : purpose;
  if (reported !== undefined && CONCURRENT_OWN_WORK_PURPOSES.has(reported)) return;
  if (openHandlerCallCount(carrier) === 0) return;

  const key = JSON.stringify([carrier.kind, carrier.id, reported ?? null, subject]);
  const existing = reportEntries.get(key);
  if (existing) {
    existing.occurrences += 1;
  } else {
    reportEntries.set(key, {
      carrier: { kind: carrier.kind, id: carrier.id },
      purpose: reported,
      subject,
      occurrences: 1,
    });
  }

  if (mode === 'warn' && !warnedEntries.has(key)) {
    warnedEntries.add(key);
    const sentWith =
      reported === undefined
        ? `sent '${subject}' without call while one of its handler calls was still open. ` +
          `Pass the handled message's ctx.call.`
        : `sent '${subject}' with own('${reported}') while one of its handler calls was still open. ` +
          `Use the handled message's ctx.call instead.`;
    console.warn(`[MakaioBus] Carrier '${carrier.kind}:${carrier.id}' ${sentWith}`);
  }
}

/**
 * Snapshot of the recorded report entries, for tests and measurement.
 * @returns Entries in first-seen order
 */
export function getOwnCallReport(): readonly OwnCallReportEntry[] {
  return [...reportEntries.values()].map((entry) => ({ ...entry, carrier: { ...entry.carrier } }));
}

/**
 * Reset counters, duplicate set and report between test runs.
 * @internal
 * @returns Reset function in test mode, undefined otherwise
 */
export const __resetOwnWork =
  process.env.NODE_ENV === 'test'
    ? () => {
        openHandlerCalls.clear();
        reportEntries.clear();
        warnedEntries.clear();
      }
    : undefined;

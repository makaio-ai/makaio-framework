/**
 * The reported form of one teardown, as it travels between the layers that
 * aggregate it.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult } from '@makaio/contracts';
import { aggregateTeardownResults } from '@makaio/contracts';

/**
 * A teardown class plus the failure that capped it.
 *
 * The wire-facing {@link ConnectorTeardownResult} carries only the class and a
 * `detail`, because that is all a consumer needs to decide anything. This shape
 * adds the original failure for the one caller that must **rethrow** it rather
 * than report it: eviction's rollback consumer builds an aggregate from the
 * throw, and returning instead of throwing would delete that signal silently.
 *
 * Kept as one type across the runtime, agent and registry layers on purpose. The
 * contract names the registry's copy an *agent* teardown report, but the fields
 * are identical at all three, and two names for one shape is how the layers
 * drift apart.
 */
export interface TeardownReport extends ConnectorTeardownResult {
  /**
   * Failure that made this class `unknown`, when there was one.
   *
   * Present only alongside `evidence: 'unknown'`. Never inspected to *derive* a
   * class — the class is derived where the failure happened, and this field only
   * carries it to a caller whose contract is to rethrow.
   */
  readonly closeError?: unknown;
}

/**
 * Report a teardown that could not be attempted or observed at all.
 * @param detail - Why nothing is known, for diagnostics.
 * @param closeError - Failure that produced this class, when one exists.
 * @returns The `unknown` report.
 */
export function unknownTeardown(detail: string, closeError?: unknown): TeardownReport {
  return { evidence: 'unknown', detail, ...(closeError !== undefined && { closeError }) };
}

/**
 * Combine several teardowns of one logical resource set into one report.
 *
 * Class and joined `detail` are the contract's {@link aggregateTeardownResults},
 * not a restatement of it. What this layer adds is the one field the wire shape
 * does not carry: the first `closeError`, so a rethrowing caller still has a
 * failure to throw.
 * @param reports - Reports from the individual teardowns.
 * @returns One report standing for all of them.
 */
export function aggregateTeardownReports(reports: readonly TeardownReport[]): TeardownReport {
  const closeError = reports.find((report) => report.closeError !== undefined)?.closeError;
  return {
    ...aggregateTeardownResults(reports),
    ...(closeError !== undefined && { closeError }),
  };
}

/**
 * Await a teardown and rethrow the failure that capped it, if there was one.
 *
 * The bridge for the callers whose contract is still a **throw**: a rollback that
 * aggregates "the operation failed *and* its cleanup failed" learns the second
 * half from an exception, and the reporting teardowns below it stopped raising
 * one. Without this the aggregate would silently lose its cleanup arm — a
 * connector and its lease left behind with nobody told.
 *
 * One helper rather than four call-site copies, because the conversion is the same
 * everywhere and a missing copy is invisible until something leaks.
 * @param teardown - Teardown whose report carries the failure, if any
 * @throws The failure that capped the reported class
 */
export async function rethrowTeardownFailure(teardown: Promise<TeardownReport>): Promise<void> {
  const report = await teardown;
  if (report.closeError !== undefined) throw report.closeError;
}

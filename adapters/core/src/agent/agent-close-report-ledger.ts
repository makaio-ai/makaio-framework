/**
 * I33's shape one layer up: a close whose report nobody took is still this
 * agent's to report.
 *
 * A connector replacement closes runtimes on the agent's behalf, and what those
 * closes observed travels to the teardown waiting on the replacement (§4a(e2)'s
 * settlement). When there is no waiter — the ordinary case, with no teardown
 * anywhere — the settlement has no consumer, and a **weak but non-throwing** class
 * would then be discarded: `detached` is the ordinary answer of a process
 * connector that signalled a kill it did not see land, so it appears in neither
 * the settlement's `unclosed` list nor any error channel. The agent would go on
 * living and its later `close()` would report only its own runtime's clean class,
 * while a generation of the replacement it rolled back may still be running.
 *
 * So the reports are booked here instead, on the party that is still answerable,
 * exactly as the `GenerationRetirementLedger` books a generation whose end no caller
 * could wait for. The ledger holds the classes and nothing else, and the
 * rule it applies is the wave's one aggregation rule: the weakest class in the set
 * is the answer.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult } from '@makaio/contracts';
import { aggregateTeardownReports, type TeardownReport } from '../connector/teardown-report.js';

/**
 * Records what closes performed for one agent observed when nothing consumed the
 * report.
 *
 * One per agent instance, and its entries are permanent: an unconsumed weak class
 * is a fact about resources this agent started, so **every** later report of the
 * agent's end is bound by it — the same reason an unretired generation caps every
 * later class a connector reports rather than only the next one.
 */
export class AgentCloseReportLedger {
  /**
   * Classes of closes performed for this agent that no waiter reported.
   *
   * Stored as the wire-facing result rather than the full report: a
   * {@link TeardownReport.closeError} is a failure whose *rethrow* contract belongs
   * to the caller that already received it — a rolled-back replacement raises the
   * compound failure to its own producer — and re-raising it from an unrelated
   * later close would report one failure twice. The class is what nobody was told,
   * and the class is what a `closeError`-bearing report contributes here: `unknown`
   * still caps every later answer.
   */
  private readonly unreported: ConnectorTeardownResult[] = [];

  /**
   * Book what closes performed for this agent observed, with nobody to report to.
   * @param reports - Reports of the closes whose settlement had no consumer
   */
  public record(reports: readonly TeardownReport[]): void {
    for (const { evidence, detail } of reports) {
      this.unreported.push({ evidence, ...(detail !== undefined && { detail }) });
    }
  }

  /**
   * Apply the ceiling the booked classes put on this agent's own report.
   *
   * A no-op while nothing is booked, so `close()` may call it unconditionally and
   * no caller has to remember the rule.
   * @param report - What this agent's own close observed
   * @returns The two aggregated, per the wave's single aggregation rule
   */
  public capReport(report: TeardownReport): TeardownReport {
    if (this.unreported.length === 0) return report;
    return aggregateTeardownReports([...this.unreported, report]);
  }
}

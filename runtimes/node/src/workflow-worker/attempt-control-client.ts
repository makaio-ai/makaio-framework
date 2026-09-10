import type { IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptSchemas,
  ExecutionAttemptSubjects,
  type ExecutionAttemptControlDelivery,
  type ExecutionAttemptControlReceipt,
  type ExecutionAttemptControlReportResponse,
} from '@makaio/contracts';
import { requestAuthorityWithRetry, type OutcomeSubmitOptions } from './outcome-submission.js';
import {
  AttemptOperationObserver,
  deriveAttemptControlConclusion,
  type DerivedBoundaryResult,
} from './attempt-control-conclusion.js';
import { installFencedAttemptEndpoint, type FencedAttemptEndpointIdentity } from './runtime-registration-client.js';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

/** Options for the report transport retried independently of the cancel signal. */
export type AttemptControlReportOptions = OutcomeSubmitOptions;

/** Dependencies for the attempt control endpoint installer. */
export interface AttemptControlEndpointDeps {
  /** Retry and reconnect options for the `control.report` retrying transport. */
  readonly reportOptions?: AttemptControlReportOptions;
  /** Outer cancellation signal for endpoint installation only, not for report delivery. */
  readonly signal?: AbortSignal;
  /** Wall-clock supplier; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Identity the control endpoint is installed for.
 *
 * The same attempt, incarnation and optional accepted generation the operation
 * delivery endpoint is installed with; both are fenced the same way.
 */
export type AttemptControlEndpointIdentity = FencedAttemptEndpointIdentity;

// ─────────────────────────────────────────────────────────────
// Endpoint handle
// ─────────────────────────────────────────────────────────────

/** Last report delivery outcome recorded by the endpoint. */
export interface AttemptControlLastReport {
  /** Terminal delivery status. */
  readonly status: 'accepted' | 'duplicate' | 'refused' | 'error';
  /** Authority response when delivery succeeded or was refused. */
  readonly response?: ExecutionAttemptControlReportResponse;
  /** Transport-level error when delivery failed. */
  readonly error?: unknown;
}

/**
 * Handle returned by {@link installAttemptControlEndpoint} after
 * `waitForSubscriptionPropagation` confirms the subscription is visible.
 */
export interface InstalledAttemptControlEndpoint {
  /**
   * Bind the accepted runtime generation received from the registration RPC.
   *
   * No delivery passes the generation fence before this, and a delivery that
   * arrives while the registration RPC is still in flight defers its answer
   * until this is called rather than being refused as stale.
   * @param runtimeGeneration - Authority-assigned generation number.
   */
  bindGeneration(runtimeGeneration: number): void;
  /**
   * Remove the bus subscription. A later delivery is a filter miss and is
   * never answered by this endpoint.
   */
  cleanup(): void;
  /**
   * Effective cancel signal, aborted once the first delivery passes the fence
   * and the receipt is stored.
   */
  readonly signal: AbortSignal;
  /**
   * Observer the invocation path uses to record lifecycle transitions so
   * the endpoint can derive an honest scoped conclusion.
   */
  readonly observer: AttemptOperationObserver;
  /**
   * Await any in-flight `control.report` delivery. Resolves without
   * throwing; transport failure is recorded in {@link lastReport}.
   */
  settle(): Promise<void>;
  /** Last recorded report delivery outcome, useful for tests and logging. */
  readonly lastReport: AttemptControlLastReport | undefined;
}

// ─────────────────────────────────────────────────────────────
// Stored receipt record
// ─────────────────────────────────────────────────────────────

/** Stored receipt keyed by controlRevision, stable across redelivery. */
interface StoredReceipt {
  readonly receipt: ExecutionAttemptControlReceipt;
  /** Whether a report run for this revision is still in flight. */
  reportPending: boolean;
  /** Terminal status of this revision's last settled report, if one settled. */
  lastReportStatus: AttemptControlLastReport['status'] | undefined;
}

/**
 * Whether a report may be dispatched for this revision now.
 *
 * `accepted`, `duplicate` and `refused` are the authority's own terminal
 * decisions about the conclusion, so the evidence is as complete as this
 * runtime can make it. A transport `error` is not a decision: the conclusion
 * never reached the store, and the authority keeps redelivering exactly while
 * a receipt exists without a report. The next trigger — an observer transition
 * or a redelivery of the same revision — therefore derives and sends again,
 * while one in-flight run per revision is never joined by a second.
 * @param stored - Stored receipt entry to test.
 * @returns True when this revision still owes the authority a report.
 */
function needsReport(stored: StoredReceipt): boolean {
  return !stored.reportPending && (stored.lastReportStatus === undefined || stored.lastReportStatus === 'error');
}

// ─────────────────────────────────────────────────────────────
// Delivery handler helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build the persisted receipt for a first-seen delivery.
 * @param delivery - Authority-to-runtime cancel delivery.
 * @param now - Current wall-clock time.
 * @returns Receipt carrying the stable first-seen timestamp.
 */
function buildReceipt(delivery: ExecutionAttemptControlDelivery, now: Date): ExecutionAttemptControlReceipt {
  return {
    executionAttemptId: delivery.executionAttemptId,
    runtimeIncarnationId: delivery.runtimeIncarnationId,
    runtimeGeneration: delivery.runtimeGeneration,
    controlRevision: delivery.cancellation.controlRevision,
    requestKey: delivery.cancellation.requestKey,
    receivedAt: now.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Report transport
// ─────────────────────────────────────────────────────────────

/**
 * Send the derived conclusion to the authority over the retrying transport.
 *
 * `accepted` and `duplicate` are delivery success. `refused` is a terminal
 * correlation fact recorded but not thrown. Transport failure is caught and
 * recorded. The report is NOT tied to the cancel signal so the workload stop
 * does not abort its own evidence submission.
 * @param bus - Runtime bus authenticated as the attempt peer.
 * @param receipt - Accepted receipt that correlates this report.
 * @param derived - Conclusive boundary and conclusion to send.
 * @param options - Retry and reconnect options.
 * @returns Last delivery outcome.
 */
async function sendControlReport(
  bus: IMakaioBus,
  receipt: ExecutionAttemptControlReceipt,
  derived: DerivedBoundaryResult,
  options: AttemptControlReportOptions | undefined,
): Promise<AttemptControlLastReport> {
  const payload = {
    executionAttemptId: receipt.executionAttemptId,
    runtimeIncarnationId: receipt.runtimeIncarnationId,
    runtimeGeneration: receipt.runtimeGeneration,
    controlRevision: receipt.controlRevision,
    requestKey: receipt.requestKey,
    ...(derived.operationId !== undefined ? { operationId: derived.operationId } : {}),
    conclusion: derived.conclusion,
  };
  try {
    const response = await requestAuthorityWithRetry<ExecutionAttemptControlReportResponse>(
      (timeout) =>
        bus.request(ExecutionAttemptSubjects.control.report, payload, {
          timeout,
        }) as Promise<ExecutionAttemptControlReportResponse>,
      options,
    );
    const validResponse = ExecutionAttemptSchemas['control.report'].response.parse(response);
    if (validResponse.decision === 'accepted' || validResponse.decision === 'duplicate') {
      return { status: validResponse.decision, response: validResponse };
    }
    return { status: 'refused', response: validResponse };
  } catch (error) {
    return { status: 'error', error };
  }
}

/** In-flight report deliveries of one endpoint, and the last recorded outcome. */
interface ReportTracker {
  /**
   * Start one report delivery and track it until it settles.
   * @param receipt - Accepted receipt that correlates the report.
   * @param derived - Conclusive boundary and conclusion to send.
   * @param onSettled - Records the outcome against the revision that owns this report.
   */
  readonly dispatch: (
    receipt: ExecutionAttemptControlReceipt,
    derived: DerivedBoundaryResult,
    onSettled: (result: AttemptControlLastReport) => void,
  ) => void;
  /**
   * Await every report still in flight.
   * @returns A promise that resolves once no dispatched report is pending.
   */
  readonly settle: () => Promise<void>;
  /** Last recorded delivery outcome, or undefined before the first settles. */
  readonly lastReport: AttemptControlLastReport | undefined;
}

/**
 * Track report deliveries so `settle()` can await all of them.
 *
 * Exactly one continuation per dispatched report records its outcome and drops
 * it from the pending set; `sendControlReport` reports transport failure as an
 * outcome instead of rejecting, so there is no second path to record. `settle`
 * awaits settlement rather than success, so a rejection that should not happen
 * still cannot turn shutdown into a throw.
 * @param bus - Runtime bus authenticated as the attempt peer.
 * @param options - Retry and reconnect options for the report transport.
 * @returns The tracker the endpoint dispatches through.
 */
function createReportTracker(bus: IMakaioBus, options: AttemptControlReportOptions | undefined): ReportTracker {
  const pending = new Set<Promise<void>>();
  let lastReport: AttemptControlLastReport | undefined;
  return {
    dispatch(receipt, derived, onSettled): void {
      const run: Promise<void> = sendControlReport(bus, receipt, derived, options).then((result) => {
        lastReport = result;
        pending.delete(run);
        onSettled(result);
      });
      pending.add(run);
    },
    async settle(): Promise<void> {
      // A delivery answered just before the endpoint was cleaned up defers its
      // cancel work and report dispatch by one macrotask (see the delivery
      // handler), so yield that turn before snapshotting; then drain until no
      // run remains, since a run may dispatch while an earlier one settles.
      await new Promise<void>((resolve) => setImmediate(resolve));
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    get lastReport(): AttemptControlLastReport | undefined {
      return lastReport;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Installer
// ─────────────────────────────────────────────────────────────

/**
 * Install this runtime's responder for `execution-attempt.control.deliver`.
 *
 * The subject is static and filtered by `{ executionAttemptId, runtimeIncarnationId }`
 * on the runtime bus — the same fenced scaffold the operation delivery endpoint
 * uses. A delivery for another attempt or incarnation is a filter miss, never
 * seen here. See the trust-boundary note on
 * {@link installFencedAttemptEndpoint} for the gap that filter leaves open, and
 * for why it is wider on this subject than on `operation.deliver`.
 *
 * The endpoint must exist before the runtime registers so that the authority's
 * `reconcileAttemptCancellation` call can reach it. The scaffold's
 * `waitForSubscriptionPropagation` await is what makes "before" true across the
 * transport.
 * @param bus - Connected runtime bus authenticated as the attempt peer.
 * @param identity - Attempt and incarnation this runtime is registered against.
 * @param deps - Report options, installation signal, and wall-clock supplier.
 * @returns The installed endpoint with a bound generation, cancel signal, observer,
 * and `settle()` awaitable.
 */
export async function installAttemptControlEndpoint(
  bus: IMakaioBus,
  identity: AttemptControlEndpointIdentity,
  deps: AttemptControlEndpointDeps = {},
): Promise<InstalledAttemptControlEndpoint> {
  const now = deps.now ?? (() => new Date());
  // Receipts keyed by controlRevision — stable across redelivery, and a
  // re-registered generation is redelivered the same revision, so the map
  // holds one entry per accepted cancel rather than one per delivery.
  const receipts = new Map<number, StoredReceipt>();
  const cancelController = new AbortController();
  const reports = createReportTracker(bus, deps.reportOptions);

  /**
   * Re-run derivation for a stored receipt and dispatch a report if conclusive.
   *
   * Derivation reads the observer, so it is deterministic in the state at call
   * time: re-running it after a failed transport is the same move as running it
   * for the first time, only later.
   * @param stored - Stored receipt entry to attempt conclusion derivation for.
   */
  function tryDerive(stored: StoredReceipt): void {
    if (!needsReport(stored)) return;
    const derived = deriveAttemptControlConclusion(observer.snapshot(), now());
    if (derived === 'pending') return;
    stored.reportPending = true;
    reports.dispatch(stored.receipt, derived, (result) => {
      stored.reportPending = false;
      stored.lastReportStatus = result.status;
    });
  }

  /**
   * Answer one fenced delivery and schedule the local cancel work it triggers.
   *
   * The receipt is the delivery's whole answer, so everything else happens
   * after it has been handed back. A macrotask is required: a microtask would
   * run before the dispatch continuation that reads the result.
   * @param delivery - Fenced cancel delivery this endpoint accepted.
   * @returns The stable receipt for this delivery's control revision.
   */
  function acceptDelivery(delivery: ExecutionAttemptControlDelivery): ExecutionAttemptControlReceipt {
    const { controlRevision } = delivery.cancellation;
    const existing = receipts.get(controlRevision);
    if (existing !== undefined) {
      // Stable replay: the identical stored receipt, no second abort and no
      // second markCancelReceived. The report is the one thing a replay may
      // still owe — see `needsReport` — so this revision is offered another
      // derivation, and a revision that already reported is left alone.
      setImmediate(() => tryDerive(existing));
      return existing.receipt;
    }
    // First-seen delivery: mint, store and answer, all synchronously.
    const stored: StoredReceipt = {
      receipt: buildReceipt(delivery, now()),
      reportPending: false,
      lastReportStatus: undefined,
    };
    receipts.set(controlRevision, stored);
    setImmediate(() => {
      cancelController.abort();
      observer.markCancelReceived();
      tryDerive(stored);
    });
    return stored.receipt;
  }

  const observer = new AttemptOperationObserver(() => {
    for (const stored of receipts.values()) {
      tryDerive(stored);
    }
  });

  const fenced = await installFencedAttemptEndpoint(
    bus,
    identity,
    (host) =>
      host.bus.on(ExecutionAttemptSubjects.control.deliver, async (ctx) => {
        // Parse before acting: a payload the contract does not know is not a
        // cancel this runtime can honour, and refusing it is not a manufactured
        // negative stop report.
        const parsed = ExecutionAttemptSchemas['control.deliver'].request.safeParse(ctx.payload);
        if (!parsed.success) {
          ctx.setResult({ decision: 'refused', reason: 'unsupported' });
          return;
        }
        const delivery = parsed.data;
        // The authority allocates the generation and may target it while the
        // registration RPC that hands it to this runtime is still in flight.
        // Refusing then would answer a durable Cancel with neither receipt nor
        // report from a runtime that is alive and about to be fenced, so the
        // answer is deferred until the bind and only then fenced. The
        // authority's own request budget bounds this wait, and `cleanup()`
        // releases it with nothing bound, which fences as stale.
        const generation = host.acceptedGeneration ?? (await host.awaitGeneration());
        if (generation === undefined || delivery.runtimeGeneration !== generation) {
          ctx.setResult({ decision: 'refused', reason: 'stale-generation' });
          return;
        }
        ctx.setResult({ decision: 'received', receipt: acceptDelivery(delivery) });
      }),
    deps.signal,
  );

  return {
    bindGeneration: (runtimeGeneration: number) => fenced.bindGeneration(runtimeGeneration),
    cleanup: () => fenced.cleanup(),
    signal: cancelController.signal,
    observer,
    settle: () => reports.settle(),
    get lastReport(): AttemptControlLastReport | undefined {
      return reports.lastReport;
    },
  };
}

import type {
  ExecutionAttemptControlConclusion,
  ExecutionAttemptOperationAdmitRefusalReason,
  ExecutionAttemptOperationKind,
} from '@makaio/contracts';
import type { SetupProcessGroupObservation } from '../workspace-preparation/setup-command.js';

// ─────────────────────────────────────────────────────────────
// Observed facts
// ─────────────────────────────────────────────────────────────

/** Operation kinds the control endpoint cares about. */
export type AdmittedOperationKind = Extract<
  ExecutionAttemptOperationKind,
  'workspace-preparation' | 'workload-invocation'
>;

/**
 * What the runtime knows about the Setup process group of a concluded preparation.
 *
 * `'not-started'`: the operation concluded before any setup command ran, so no
 *   process group ever existed under it.
 * `'no-spawn'`: setup ran and returned a result without a process group, which
 *   the driver contract states exactly when no process was ever spawned — so
 *   the absence of a live group is proven, not unknown.
 * `'no-observation'`: the driver threw before handing over any result, so it
 *   supplied no process-group fact either way.
 */
export type SetupConclusion = 'not-started' | 'no-spawn' | 'no-observation' | SetupProcessGroupObservation;

/**
 * The one terminal fact an admitted operation concludes with.
 *
 * Preparation carries its Setup process-group fact; a workload invocation has
 * no equivalent, because the generic adapter observes no process of its own.
 */
export type ConcludedOperation =
  | {
      readonly kind: 'workspace-preparation';
      readonly operationId: string;
      readonly setup: SetupConclusion;
    }
  | { readonly kind: 'workload-invocation'; readonly operationId: string };

/** Snapshot of observer state used for conclusion derivation. */
export interface AttemptControlState {
  /** Whether the authority has delivered a cancel to this endpoint. */
  readonly cancelReceived: boolean;
  /**
   * Whether the runtime is still waiting for an admission response.
   * While true, `admission-closed` is never a valid conclusion.
   */
  readonly admissionPending: boolean;
  /**
   * Whether an admission request reached a completed authority response. A
   * settled admission that admitted nothing closed this runtime out; an
   * unanswered one stays pending, because it may still occupy the attempt.
   */
  readonly admissionSettled: boolean;
  /** Reason the last settled admission was refused, or null if none was refused. */
  readonly admissionRefusalReason: ExecutionAttemptOperationAdmitRefusalReason | null;
  /** Last admitted mutating operation, or null if none. */
  readonly admittedOperation: {
    readonly kind: AdmittedOperationKind;
    readonly operationId: string;
  } | null;
  /** Terminal fact of the operation that concluded, or null while none has. */
  readonly conclusion: ConcludedOperation | null;
  /** Whether the runtime has signalled that no further transitions will occur. */
  readonly finished: boolean;
}

// ─────────────────────────────────────────────────────────────
// Evidence rendering
// ─────────────────────────────────────────────────────────────

// The German exception for Atlassian-facing copy does NOT apply to any string
// in this module: durable control evidence is machine-facing framework data.

/** Summary per driver outcome; the driver records the outcome, this renders it. */
const OUTCOME_SUMMARY = {
  exited: 'setup process group leader exited; whole group proven quiescent',
  'signalled-and-quiesced': 'setup process group signalled; group proven quiescent afterwards',
  'signalled-unconfirmed': 'setup process group signalled; quiescence not proven',
  'unsignalled-unconfirmed': 'setup process group could not be signalled; quiescence not proven',
} as const;

/** Why quiescence stayed unproven, appended to the outcome summary. */
const CAUSE_SUMMARY = {
  'poll-timeout': 'quiescence poll timed out',
  'ps-unavailable': 'ps unavailable on this host',
  'signal-error': 'a cleanup signal failed',
} as const;

/**
 * Render the bounded, non-empty summary of one driver observation.
 *
 * Both parts are fixed literals, so the result stays far inside the durable
 * evidence summary limit without truncation.
 * @param observation - Raw driver-recorded process-group fact.
 * @returns Human-readable summary of the outcome and, when present, its cause.
 */
function renderSetupSummary(observation: SetupProcessGroupObservation): string {
  const outcome = OUTCOME_SUMMARY[observation.outcome];
  return observation.cause === undefined ? outcome : `${outcome} (${CAUSE_SUMMARY[observation.cause]})`;
}

// ─────────────────────────────────────────────────────────────
// Derivation
// ─────────────────────────────────────────────────────────────

/** Conclusive derivation result carrying all report fields. */
export interface DerivedBoundaryResult {
  readonly operationId?: string;
  readonly conclusion: ExecutionAttemptControlConclusion;
}

/** Facts one boundary conclusion is assembled from, before it takes evidence shape. */
interface BoundaryFacts {
  readonly operationId?: string;
  readonly status: ExecutionAttemptControlConclusion['status'];
  readonly boundary: ExecutionAttemptControlConclusion['boundary'];
  readonly source: string;
  readonly summary: string;
  readonly observedAt: Date;
  readonly code?: string;
}

/**
 * Assemble the single evidence shape every boundary conclusion reports with.
 * @param facts - Boundary, status and evidence values of one conclusion.
 * @returns Report-ready boundary result.
 */
function conclude(facts: BoundaryFacts): DerivedBoundaryResult {
  return {
    ...(facts.operationId === undefined ? {} : { operationId: facts.operationId }),
    conclusion: {
      status: facts.status,
      boundary: facts.boundary,
      evidence: {
        source: facts.source,
        summary: facts.summary,
        observedAt: facts.observedAt.toISOString(),
        ...(facts.code === undefined ? {} : { code: facts.code }),
      },
    },
  };
}

/**
 * Derive the runtime's scoped control conclusion from observed state.
 *
 * Returns `'pending'` whenever the cancel has not been received or the
 * available facts are still insufficient to reach a conclusion. The
 * caller re-runs derivation on every observer transition until a
 * conclusive result is returned and exactly one report is sent.
 * @param state - Snapshot of observer state at derivation time.
 * @param now - Instant used for evidence that has no observation timestamp of its own.
 * @returns Conclusive boundary result, or `'pending'`.
 */
export function deriveAttemptControlConclusion(
  state: AttemptControlState,
  now: Date,
): DerivedBoundaryResult | 'pending' {
  if (!state.cancelReceived) return 'pending';

  // R2: a delayed admission response may represent durable admission;
  // never conclude admission-closed while the response is outstanding.
  if (state.admissionPending) return 'pending';

  const admitted = state.admittedOperation;
  if (admitted === null) {
    // Nothing mutating was admitted. Only a settled admission or a finished
    // runtime proves that nothing ever will be.
    if (!state.admissionSettled && !state.finished) return 'pending';
    return conclude({
      status: 'achieved',
      boundary: 'admission-closed',
      source: 'headless-runtime',
      summary: renderAdmissionClosedSummary(state.admissionRefusalReason),
      observedAt: now,
    });
  }

  if (admitted.kind === 'workload-invocation') {
    return conclude({
      operationId: admitted.operationId,
      status: 'unsupported',
      boundary: 'workload',
      source: 'headless-runtime',
      summary: 'generic workload adapter offers no stop evidence',
      observedAt: now,
    });
  }

  // Preparation: the stop proof is the concluded operation's own setup fact,
  // and only the fact of this operation counts as its evidence.
  const concluded = state.conclusion;
  if (concluded === null || concluded.kind !== 'workspace-preparation') return 'pending';
  if (concluded.operationId !== admitted.operationId) return 'pending';
  return concludeSetupBoundary(admitted.operationId, concluded.setup, now);
}

/**
 * Render the admission-closed summary, naming the refusal when the authority gave one.
 * @param refusalReason - Authority refusal reason, or null when nothing was refused.
 * @returns Bounded summary for the admission-closed boundary.
 */
function renderAdmissionClosedSummary(refusalReason: ExecutionAttemptOperationAdmitRefusalReason | null): string {
  const closed = 'no mutating operation admitted before cancellation';
  return refusalReason === null ? closed : `${closed}; admission refused (${refusalReason})`;
}

/**
 * Map the terminal setup fact of an admitted preparation onto its boundary.
 * @param operationId - Authority-assigned identifier of the admitted preparation operation.
 * @param setup - Terminal setup fact the operation concluded with.
 * @param now - Instant used when the fact carries no observation timestamp.
 * @returns Derived boundary result for the setup-process-group boundary.
 */
function concludeSetupBoundary(operationId: string, setup: SetupConclusion, now: Date): DerivedBoundaryResult {
  if (setup === 'not-started') {
    return conclude({
      operationId,
      status: 'achieved',
      boundary: 'setup-process-group',
      source: 'headless-runtime',
      summary: 'preparation admitted; setup never started before cancellation',
      observedAt: now,
    });
  }
  if (setup === 'no-spawn') {
    return conclude({
      operationId,
      status: 'achieved',
      boundary: 'setup-process-group',
      source: 'setup-driver',
      summary: 'no live setup process group remains under this operation',
      observedAt: now,
    });
  }
  if (setup === 'no-observation') {
    return conclude({
      operationId,
      status: 'unsupported',
      boundary: 'setup-process-group',
      source: 'setup-driver',
      summary: 'setup driver supplied no process-group observation',
      observedAt: now,
    });
  }
  return conclude({
    operationId,
    status:
      setup.outcome === 'signalled-unconfirmed' || setup.outcome === 'unsignalled-unconfirmed'
        ? 'unconfirmed'
        : 'achieved',
    boundary: 'setup-process-group',
    source: 'setup-driver',
    summary: renderSetupSummary(setup),
    observedAt: setup.observedAt,
    code: setup.outcome,
  });
}

// ─────────────────────────────────────────────────────────────
// Observer
// ─────────────────────────────────────────────────────────────

/** Mutable backing state; {@link AttemptControlState} is its read-only view. */
type MutableAttemptControlState = { -readonly [Key in keyof AttemptControlState]: AttemptControlState[Key] };

/**
 * Records runtime-local operation lifecycle events so the control endpoint
 * can derive an honest scoped conclusion after a cancel is received.
 *
 * The invocation path calls these methods as it moves through admission and
 * its operations. The observer never throws; it records state and triggers
 * conclusion derivation.
 */
export class AttemptOperationObserver {
  private readonly state: MutableAttemptControlState = {
    cancelReceived: false,
    admissionPending: false,
    admissionSettled: false,
    admissionRefusalReason: null,
    admittedOperation: null,
    conclusion: null,
    finished: false,
  };

  private readonly onUpdate: () => void;

  /**
   * @param onUpdate - Called after every state transition that may change the conclusion.
   */
  public constructor(onUpdate: () => void) {
    this.onUpdate = onUpdate;
  }

  /** Signal that a cancel has been received (called by the delivery handler). */
  public markCancelReceived(): void {
    this.state.cancelReceived = true;
    this.onUpdate();
  }

  /**
   * The runtime is waiting for an admission response; conclusion is deferred.
   * Call before sending `operation.admit`, and before {@link admissionSettled}.
   */
  public admissionPending(): void {
    this.state.admissionPending = true;
    this.onUpdate();
  }

  /**
   * An admission request reached a completed authority response.
   *
   * Any completed response settles the question of whether this runtime holds
   * an operation — a refusal for any reason means it does not. A transport
   * failure is not a settlement and must leave the admission pending.
   * @param refusalReason - Authority refusal reason, omitted when the operation was admitted.
   */
  public admissionSettled(refusalReason?: ExecutionAttemptOperationAdmitRefusalReason): void {
    this.state.admissionPending = false;
    this.state.admissionSettled = true;
    if (refusalReason !== undefined) this.state.admissionRefusalReason = refusalReason;
    this.onUpdate();
  }

  /**
   * An operation was admitted by the authority.
   * @param kind - `'workspace-preparation'` or `'workload-invocation'`.
   * @param operationId - Authority-assigned stable operation identifier.
   */
  public operationAdmitted(kind: AdmittedOperationKind, operationId: string): void {
    this.state.admissionPending = false;
    this.state.admittedOperation = { kind, operationId };
    this.onUpdate();
  }

  /**
   * The admitted operation concluded, carrying its one terminal fact.
   * @param concluded - Operation identity and the setup fact it concluded with.
   */
  public operationConcluded(concluded: ConcludedOperation): void {
    this.state.conclusion = concluded;
    this.onUpdate();
  }

  /**
   * The runtime has completed; no further transitions will occur.
   * Enables `admission-closed` when no mutating operation was ever admitted.
   */
  public finished(): void {
    this.state.finished = true;
    this.onUpdate();
  }

  /**
   * Return an immutable snapshot suitable for derivation.
   * @returns Immutable copy of the current observer state.
   */
  public snapshot(): AttemptControlState {
    return { ...this.state };
  }
}

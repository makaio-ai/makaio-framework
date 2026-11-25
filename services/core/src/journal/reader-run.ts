import { SubjectPatternSchema, type ReaderContribution, type ReaderOutcome } from '@makaio/contracts/journal';
import { RightDenialReason } from '@makaio/contracts/rights';
import type { CallContext } from '@makaio/core';
import { resolveReadAccess, type JournalReaderAuthority } from './reader-access.js';
import { READER_INITIAL_RETRY_DELAY_MS, ReaderCursorLostError } from './storage/reader-claims.js';
import type { JournalReaderStore, ReaderClaim, ReaderCursorReservation } from './storage/reader-store.js';
import type { SubjectDirectory } from './subject-directory.js';

const LEASE_MS = 30_000;
const CONCURRENCY = 8;
const MAX_TIMER_MS = 2_147_483_647;

type ReaderHost = JournalReaderAuthority & { readonly directory: SubjectDirectory };

type AttemptOutcome = ReaderOutcome | { state: 'denied' };

/** Trusted context for a staged activation. */
interface ReaderActivation {
  readonly call: CallContext;
  readonly isActive: () => boolean;
  readonly canSelect?: () => boolean;
  readonly cursor: ReaderCursorReservation;
}

/** Snapshot the patterns for one selection.
 * @param contribution - Reader whose patterns are being selected.
 * @returns A validated copy of the current patterns.
 */
export function readerPatterns(contribution: ReaderContribution): readonly string[] {
  return SubjectPatternSchema.array().parse(contribution.subjects());
}

/**
 * Bound one attempt without waiting for abandoned handler code to return.
 * @param expiresAt - Claim expiry in epoch milliseconds.
 * @param stop - Signal of the particular activation.
 * @param run - Handler and authorization, both outside the transaction.
 * @returns The result, or a retry when the deadline or activation ends.
 */
async function runUntilDeadline(
  expiresAt: number,
  stop: AbortSignal,
  run: (signal: AbortSignal) => Promise<AttemptOutcome>,
): Promise<AttemptOutcome> {
  const deadline = new AbortController();
  const cancel = (): void => deadline.abort();
  const signal = AbortSignal.any([stop, deadline.signal]);
  const timer = setTimeout(cancel, Math.max(0, expiresAt - Date.now()));
  let notifyAbort: (() => void) | undefined;

  try {
    const expired: AttemptOutcome = { state: 'retry', reason: 'deadline-exceeded' };
    if (signal.aborted || expiresAt <= Date.now()) return expired;

    const aborted = new Promise<AttemptOutcome>((resolve) => {
      notifyAbort = () => resolve(expired);
      signal.addEventListener('abort', notifyAbort, { once: true });
    });
    return await Promise.race([aborted, run(signal)]);
  } finally {
    clearTimeout(timer);
    if (notifyAbort) signal.removeEventListener('abort', notifyAbort);
  }
}

/** One generation of a reader and the work it has dispatched. */
export class JournalReaderRun {
  private readonly stop = new AbortController();
  private readonly attempts = new Set<Promise<void>>();
  private selection?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private pending = false;
  private lastPatterns?: readonly string[];

  /**
   * @param contribution - Reader contributed by this activation.
   * @param store - Host-backed reader storage.
   * @param authority - Host authority for stored rows.
   * @param activation - Generation's own call and activation predicate.
   */
  public constructor(
    private readonly contribution: ReaderContribution,
    private readonly store: JournalReaderStore,
    private readonly authority: ReaderHost,
    private readonly activation: ReaderActivation,
  ) {}

  private readonly isCurrent = (): boolean => !this.stop.signal.aborted && this.activation.isActive();

  private readonly canSelect = (): boolean => this.isCurrent() && (this.activation.canSelect?.() ?? true);

  /** Start or request another database selection, coalescing concurrent wakes. */
  public wake(): void {
    if (!this.canSelect()) return;
    this.pending = true;
    clearTimeout(this.timer);
    if (this.selection) return;
    this.selection = this.selectWithRecovery()
      .catch(() => {
        console.error('[Journal] Reader selection failed');
        this.scheduleWake(Date.now() + READER_INITIAL_RETRY_DELAY_MS);
      })
      .finally(() => {
        this.selection = undefined;
        if (this.pending) this.wake();
      });
  }

  /** Withdraw this generation and wait for its database operations to finish. */
  public async close(): Promise<void> {
    this.stop.abort();
    clearTimeout(this.timer);
    await this.selection;
    await Promise.all(this.attempts);
  }

  /**
   * Wake at the next due time unless a wake is already pending or the run has stopped.
   * @param due - Desired wake time in epoch milliseconds.
   */
  private scheduleWake(due: number): void {
    if (!this.canSelect() || this.pending) return;
    this.timer = setTimeout(() => this.wake(), Math.min(MAX_TIMER_MS, Math.max(0, due - Date.now())));
  }

  /** Recover a lost cursor by exact name before taking any more work. */
  private async selectWithRecovery(): Promise<void> {
    try {
      await this.select();
    } catch (error) {
      if (!(error instanceof ReaderCursorLostError)) throw error;
      console.error('[Journal] Active reader lost its cursor (reader-cursor-lost)');
      if (!this.canSelect()) return;
      await this.store.restoreCursor(this.activation.cursor);
      this.wake();
    }
  }

  /**
   * Dispatch eligible rows up to the concurrency limit and schedule the next
   * persisted due time when there is room to take more work.
   */
  private async select(): Promise<void> {
    this.pending = false;
    const { reader } = this.contribution;
    if (!this.canSelect()) return;
    const { owner } = this.activation.cursor;
    await this.store.admit(reader, this.patterns(), this.canSelect, owner);
    while (this.canSelect() && this.attempts.size < CONCURRENCY) {
      const patterns = this.patterns();
      const claim = await this.store.claim(reader, LEASE_MS, patterns, this.canSelect, owner);
      if (!this.isCurrent()) return;
      if (!claim) {
        const due = await this.store.nextDue(reader, patterns);
        if (due !== undefined) this.scheduleWake(due);
        return;
      }
      this.dispatch(claim);
    }
  }

  /**
   * Warn when a newly selected pattern is absent from the recorded directory.
   * @returns The current validated patterns.
   */
  private patterns(): readonly string[] {
    const patterns = readerPatterns(this.contribution);
    for (const pattern of patterns) {
      if (!this.lastPatterns?.includes(pattern) && !this.authority.directory.hasRecordedSubject(pattern)) {
        console.warn(
          `[Journal] Reader "${this.contribution.reader}" pattern "${pattern}" matches no recorded subject.`,
        );
      }
    }
    this.lastPatterns = patterns;
    return patterns;
  }

  /**
   * Track one attempt until its result has settled or the lease has expired.
   * @param claim - Exclusive claim to the stored row.
   */
  private dispatch(claim: ReaderClaim): void {
    const attempt = this.process(claim)
      .catch(() => console.error('[Journal] Reader settlement failed'))
      .finally(() => {
        this.attempts.delete(attempt);
        this.wake();
      });
    this.attempts.add(attempt);
  }

  /**
   * Authorize as the reader, then handle with the stored principal and attestation.
   * @param claim - Exclusive claim with the stored entry and deadline.
   */
  private async process(claim: ReaderClaim): Promise<void> {
    const { entry, expiresAt } = claim;
    const result = await runUntilDeadline(expiresAt, this.stop.signal, async (signal) => {
      const access = await resolveReadAccess(this.authority, this.activation.call, entry);
      if (!access.granted) {
        const { reason } = access;
        return reason === RightDenialReason.sourceUnavailable || reason === RightDenialReason.resolutionFailed
          ? { state: 'retry', reason }
          : { state: 'denied' };
      }
      if (signal.aborted || !this.isCurrent() || expiresAt <= Date.now()) {
        return { state: 'retry', reason: 'deadline-exceeded' };
      }
      const call = this.authority.bindCall(this.activation.call.caller, entry.origin);
      return this.contribution.handle(call, entry, { deadline: new Date(expiresAt).toISOString() });
    }).catch((): AttemptOutcome => ({ state: 'retry', reason: 'handler-threw' }));

    if (this.isCurrent()) await this.store.settle(claim, result, this.isCurrent);
  }
}

/**
 * A target tracked by {@link OverdueScheduler}.
 *
 * `targetIntervalMs` is the *desired* cadence; under contention the scheduler
 * may refresh the target less often than that in exchange for respecting the
 * single-slot-per-tick budget imposed by the caller.
 */
export interface SchedulableTarget<K> {
  /** Caller-defined identity for the target (e.g. `clientId:accountId`). */
  key: K;
  /** Epoch ms of the last successful or attempted fetch for this target. */
  lastFetchAt: number;
  /** Desired interval between fetches for this target. */
  targetIntervalMs: number;
  /**
   * Optional tiebreaker for equally overdue targets. Higher wins.
   * Useful to prefer e.g. active accounts over inactive ones when both are due.
   */
  priority?: number;
}

/**
 * Priority scheduler that fills a scarce fetch budget with the single most
 * overdue target at each tick.
 *
 * "Overdueness" is measured as `(now - lastFetchAt) / targetIntervalMs`: a
 * value ≥ 1 means the target has waited at least its target interval. When
 * several targets are tied for overdueness, the higher `priority` wins; when
 * priorities also tie, the earlier `lastFetchAt` (oldest data) wins so the
 * scheduler is deterministic across ticks.
 *
 * The scheduler is intentionally stateless — callers own the
 * `SchedulableTarget` collection and the lastFetchAt bookkeeping. This keeps
 * it reusable across sources (Claude Code, Codex, future providers) without
 * tying it to any particular store shape.
 */
export class OverdueScheduler {
  /**
   * Picks the single most-overdue target that has exceeded its target
   * interval, or `null` if no target is currently due.
   * @param targets - Candidate targets.
   * @param now - Current epoch ms (injected for testability).
   * @returns The chosen target, or `null` when nothing is due.
   */
  public pick<K>(targets: Iterable<SchedulableTarget<K>>, now: number): SchedulableTarget<K> | null {
    let winner: SchedulableTarget<K> | null = null;
    let winnerScore = 1; // strictly > 1 beats this; == 1 is the "just due" threshold

    for (const t of targets) {
      const elapsed = now - t.lastFetchAt;
      if (elapsed < t.targetIntervalMs) continue;
      const score = t.targetIntervalMs === 0 ? Number.POSITIVE_INFINITY : elapsed / t.targetIntervalMs;

      if (winner === null || this.beats(t, score, winner, winnerScore)) {
        winner = t;
        winnerScore = score;
      }
    }

    return winner;
  }

  /**
   * Ranks candidate over incumbent: higher score, then higher priority, then
   * older lastFetchAt. Split into a helper so the rule is readable as one
   * short expression rather than a nested ternary inside `pick`.
   * @param candidate - The target under consideration.
   * @param candidateScore - Its precomputed overdueness score.
   * @param incumbent - The current best target.
   * @param incumbentScore - The current best's precomputed score.
   * @returns `true` when the candidate should replace the incumbent.
   */
  private beats<K>(
    candidate: SchedulableTarget<K>,
    candidateScore: number,
    incumbent: SchedulableTarget<K>,
    incumbentScore: number,
  ): boolean {
    if (candidateScore !== incumbentScore) return candidateScore > incumbentScore;
    const candidatePriority = candidate.priority ?? 0;
    const incumbentPriority = incumbent.priority ?? 0;
    if (candidatePriority !== incumbentPriority) return candidatePriority > incumbentPriority;
    return candidate.lastFetchAt < incumbent.lastFetchAt;
  }
}

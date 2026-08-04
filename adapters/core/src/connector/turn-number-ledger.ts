/**
 * Monotonic turn-number bookkeeping shared by all agent connectors.
 *
 * Tracks two values: the committed turn number the connector is currently on,
 * and an optional canonical turn number staged by the session orchestrator
 * (e.g. across a connector swap) that the next {@link TurnNumberLedger.consume}
 * call adopts. Both values only ever move forward — a regression is a
 * programming error and throws rather than silently rewinding MCP tool-ledger
 * bookkeeping keyed on these numbers.
 */
export class TurnNumberLedger {
  /** Committed turn number; 0 until the first turn starts. */
  private committed = 0;
  /** Canonical turn number staged for the next {@link consume} call. */
  private staged: number | undefined;

  /**
   * Stage a canonical orchestrator-assigned turn number for consumption by the
   * next {@link consume} call.
   * @param turnNumber - Canonical 1-based turn number
   * @throws RangeError when the value is invalid, regresses behind the
   * committed counter, or downgrades an already staged value
   */
  public stage(turnNumber: number): void {
    if (!Number.isInteger(turnNumber) || turnNumber < 1) {
      throw new RangeError(`canonical turn number: expected positive integer, got ${turnNumber}`);
    }
    if (turnNumber <= this.committed) {
      throw new RangeError(`canonical turn number: ${turnNumber} ≤ committed (${this.committed})`);
    }
    if (this.staged !== undefined && turnNumber < this.staged) {
      throw new RangeError(`canonical turn number: ${turnNumber} < staged (${this.staged})`);
    }
    this.staged = turnNumber;
  }

  /**
   * Advance to the next turn number, consuming any staged canonical value.
   * Staged values win; otherwise the committed counter increments by one.
   * @returns The committed turn number after advancement
   */
  public consume(): number {
    if (this.staged !== undefined) {
      this.committed = this.staged;
      this.staged = undefined;
    } else {
      this.committed += 1;
    }
    return this.committed;
  }

  /**
   * Committed turn number (read-only). Use {@link consume} to advance.
   * @returns The committed turn number
   */
  public get current(): number {
    return this.committed;
  }

  /**
   * Staged canonical turn number, or `undefined` when none is staged.
   * @returns The staged canonical turn number
   */
  public get pending(): number | undefined {
    return this.staged;
  }
}

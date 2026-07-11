/**
 * Deduplicate credential-change requests per provider config.
 *
 * Connector exclusivity belongs to the agent-wide runtime mutation barrier;
 * this collaborator owns only monotonic credential-change sequence state.
 */
export class CredentialChangeSequencer {
  // The sequencer is scoped to one agent runtime; there is no provider-config
  // deletion subscription at this layer, so entries are bounded by configs that
  // actually delivered credential changes to this live agent.
  private readonly queuedSequences = new Map<string, number>();
  private readonly appliedSequences = new Map<string, number>();

  /**
   * Queue a change sequence when it is newer than any queued/applied sequence
   * for the same provider config.
   * @param providerConfigId - Provider config receiving rotated credentials.
   * @param changeSequence - Monotonic change sequence from the event contract.
   * @returns Whether the change should proceed.
   */
  public queue(providerConfigId: string, changeSequence: number): boolean {
    if (!Number.isSafeInteger(changeSequence) || changeSequence < 0) {
      return false;
    }

    const appliedSequence = this.appliedSequences.get(providerConfigId);
    if (appliedSequence !== undefined && changeSequence <= appliedSequence) {
      return false;
    }

    const queuedSequence = this.queuedSequences.get(providerConfigId);
    if (queuedSequence !== undefined && changeSequence <= queuedSequence) {
      return false;
    }

    this.queuedSequences.set(providerConfigId, changeSequence);
    return true;
  }

  /**
   * Check whether a sequence is still the latest queued change for a config.
   * @param providerConfigId - Provider config identifier.
   * @param changeSequence - Sequence being processed.
   * @returns True when the sequence is still current.
   */
  public isLatest(providerConfigId: string, changeSequence: number): boolean {
    return this.queuedSequences.get(providerConfigId) === changeSequence;
  }

  /**
   * Mark a sequence as successfully applied.
   * @param providerConfigId - Provider config identifier.
   * @param changeSequence - Applied change sequence.
   */
  public markApplied(providerConfigId: string, changeSequence: number): void {
    const current = this.appliedSequences.get(providerConfigId);
    if (current === undefined || changeSequence > current) {
      this.appliedSequences.set(providerConfigId, changeSequence);
    }
    if (this.queuedSequences.get(providerConfigId) === changeSequence) {
      this.queuedSequences.delete(providerConfigId);
    }
  }

  /**
   * Release a queued change after failure or early exit.
   * @param providerConfigId - Provider config identifier.
   * @param changeSequence - Queued change sequence to release.
   */
  public release(providerConfigId: string, changeSequence: number): void {
    if (this.queuedSequences.get(providerConfigId) !== changeSequence) {
      return;
    }

    const appliedSequence = this.appliedSequences.get(providerConfigId);
    if (appliedSequence === undefined || changeSequence > appliedSequence) {
      this.queuedSequences.delete(providerConfigId);
    }
  }

  /**
   * Drop all tracked sequence state for a provider config lifecycle.
   * @param providerConfigId - Provider config identifier to forget.
   */
  public clear(providerConfigId: string): void {
    this.queuedSequences.delete(providerConfigId);
    this.appliedSequences.delete(providerConfigId);
  }
}

import type { TriggerContribution } from '@makaio/contracts/rules';
import { ContributionRegistryCore } from '../contribution-registry/index.js';

/**
 * Owner-aware registry for trigger contributions.
 *
 * Registration is keyed by the owning extension: every trigger kind must
 * carry the canonical `<owner>.` prefix, kinds are globally unique, and a
 * registration batch is atomic. A trigger is only a projection (it translates
 * a journal entry or a message into facts); this registry only tracks
 * ownership and discovery, never activates anything.
 */
export class TriggerRegistry {
  /** Generic owner-aware name index, owner check, and batch lifecycle. */
  private readonly core = new ContributionRegistryCore<TriggerContribution>({
    label: 'Trigger',
    nameOf: (trigger) => trigger.kind,
  });

  /**
   * Atomically registers the complete trigger batch contributed by an extension.
   * @param owner - The extension contributing the complete batch.
   * @param triggers - Complete trigger contributions to register.
   * @throws If a kind is not namespaced by `<owner>.`, duplicates another
   *   incoming kind, or belongs to another owner.
   */
  public register(owner: string, triggers: readonly TriggerContribution[]): void {
    this.core.validateBatch(owner, triggers);
    this.core.commitBatch(owner, triggers);
  }

  /**
   * Deregisters all triggers contributed by an extension. Idempotent.
   * @param owner - The extension to remove.
   */
  public deregister(owner: string): void {
    if (this.core.ownerBatch(owner) === undefined) return;
    this.core.commitBatch(owner, []);
  }

  /**
   * Resolves a trigger by its canonical kind.
   * @param kind - Canonical trigger kind.
   * @returns The registered trigger, or `undefined` when not registered.
   */
  public get(kind: string): TriggerContribution | undefined {
    return this.core.get(kind);
  }

  /**
   * Lists every registered trigger across every owner.
   * @returns A live snapshot array of every registered trigger.
   */
  public list(): readonly TriggerContribution[] {
    return this.core.list();
  }

  /**
   * Lists the registered triggers with their owners.
   * @returns An owned contribution snapshot.
   */
  public listOwned(): ReadonlyArray<{ extension: string; entry: TriggerContribution }> {
    return this.core.listOwned();
  }

  /** Removes every registered trigger, from every owner. */
  public clear(): void {
    this.core.clear();
  }
}

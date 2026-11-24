import type { GroupStrategyContribution } from '@makaio/contracts/rules';
import { ContributionRegistryCore } from '../contribution-registry/index.js';

/**
 * Owner-aware registry for group-strategy contributions.
 *
 * Registration is keyed by the owning extension: every strategy kind must
 * carry the canonical `<owner>.` prefix, kinds are globally unique, and a
 * registration batch is atomic. A strategy decides over the members of a
 * group on one occasion; this registry only tracks ownership and discovery,
 * never decides anything.
 */
export class GroupStrategyRegistry {
  /** Generic owner-aware name index, owner check, and batch lifecycle. */
  private readonly core = new ContributionRegistryCore<GroupStrategyContribution>({
    label: 'Group strategy',
    nameOf: (strategy) => strategy.strategy,
  });

  /**
   * Atomically registers the complete group-strategy batch contributed by an extension.
   * @param owner - The extension contributing the complete batch.
   * @param strategies - Complete group-strategy contributions to register.
   * @throws If a kind is not namespaced by `<owner>.`, duplicates another
   *   incoming kind, or belongs to another owner.
   */
  public register(owner: string, strategies: readonly GroupStrategyContribution[]): void {
    this.core.validateBatch(owner, strategies);
    this.core.commitBatch(owner, strategies);
  }

  /**
   * Deregisters all group strategies contributed by an extension. Idempotent.
   * @param owner - The extension to remove.
   */
  public deregister(owner: string): void {
    if (this.core.ownerBatch(owner) === undefined) return;
    this.core.commitBatch(owner, []);
  }

  /**
   * Resolves a group strategy by its canonical kind.
   * @param kind - Canonical strategy kind.
   * @returns The registered strategy, or `undefined` when not registered.
   */
  public get(kind: string): GroupStrategyContribution | undefined {
    return this.core.get(kind);
  }

  /**
   * Lists every registered group strategy across every owner.
   * @returns A live snapshot array of every registered strategy.
   */
  public list(): readonly GroupStrategyContribution[] {
    return this.core.list();
  }

  /** Removes every registered group strategy, from every owner. */
  public clear(): void {
    this.core.clear();
  }
}

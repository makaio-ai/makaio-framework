import type { RuleBlockContribution } from '@makaio/contracts/rules';
import { ContributionRegistryCore } from '../contribution-registry/index.js';

/** One extension's registered rule block, paired with its owner for lookup by owner. */
interface RegisteredRuleBlock {
  /** Extension that declared this block. */
  readonly owner: string;
  /** The block's contributed shape and own check. */
  readonly contribution: RuleBlockContribution;
}

/**
 * Owner-aware registry for rule-block contributions.
 *
 * Unlike the other rule contribution kinds, a rule block carries no name of
 * its own: it is read under `ReactionRule.extensions[<owner>]`, so its
 * registered "name" is the owning extension's own name. At most one rule
 * block per extension — a second one from the same extension replaces the
 * first, the same whole-batch-of-one-or-zero semantics every other
 * contribution kind uses.
 */
export class RuleBlockRegistry {
  /** Generic owner-aware name index, owner check, and batch lifecycle. */
  private readonly core = new ContributionRegistryCore<RegisteredRuleBlock>({
    label: 'Rule block',
    nameOf: (entry) => entry.owner,
    // A rule block is keyed by the owner's own name, not a `<owner>.<rest>`
    // contribution name: there is no further local name to own.
    ownsName: (owner, name) => name === owner,
  });

  /**
   * Registers the rule block contributed by an extension, replacing any
   * prior block from the same extension.
   * @param owner - The extension contributing the block.
   * @param contribution - The block's schema and own check.
   */
  public register(owner: string, contribution: RuleBlockContribution): void {
    const batch: readonly RegisteredRuleBlock[] = [{ owner, contribution }];
    this.core.validateBatch(owner, batch);
    this.core.commitBatch(owner, batch);
  }

  /**
   * Deregisters the rule block contributed by an extension. Idempotent.
   * @param owner - The extension to remove.
   */
  public deregister(owner: string): void {
    if (this.core.ownerBatch(owner) === undefined) return;
    this.core.commitBatch(owner, []);
  }

  /**
   * Resolves the rule block contributed by an extension.
   * @param owner - Extension that may have declared a rule block.
   * @returns The registered block, or `undefined` when the extension declared none.
   */
  public get(owner: string): RuleBlockContribution | undefined {
    return this.core.get(owner)?.contribution;
  }

  /**
   * Lists every registered rule block, with the extension that declared it.
   * @returns A live snapshot array of every registered block, by owner.
   */
  public list(): readonly RegisteredRuleBlock[] {
    return this.core.list();
  }

  /** Removes every registered rule block, from every owner. */
  public clear(): void {
    this.core.clear();
  }
}

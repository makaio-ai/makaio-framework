import type { LookupContribution } from '@makaio/contracts/rules';
import { ContributionRegistryCore } from '../contribution-registry/index.js';

/**
 * Owner-aware registry for lookup contributions.
 *
 * Registration is keyed by the owning extension: every lookup kind must
 * carry the canonical `<owner>.` prefix, kinds are globally unique, and a
 * registration batch is atomic. A lookup reads only, has a deadline, and
 * gives the same answer for the same data; this registry only tracks
 * ownership and discovery, never resolves anything.
 */
export class LookupRegistry {
  /** Generic owner-aware name index, owner check, and batch lifecycle. */
  private readonly core = new ContributionRegistryCore<LookupContribution>({
    label: 'Lookup',
    nameOf: (lookup) => lookup.kind,
  });

  /**
   * Atomically registers the complete lookup batch contributed by an extension.
   * @param owner - The extension contributing the complete batch.
   * @param lookups - Complete lookup contributions to register.
   * @throws If a kind is not namespaced by `<owner>.`, duplicates another
   *   incoming kind, or belongs to another owner.
   */
  public register(owner: string, lookups: readonly LookupContribution[]): void {
    this.core.validateBatch(owner, lookups);
    this.core.commitBatch(owner, lookups);
  }

  /**
   * Deregisters all lookups contributed by an extension. Idempotent.
   * @param owner - The extension to remove.
   */
  public deregister(owner: string): void {
    if (this.core.ownerBatch(owner) === undefined) return;
    this.core.commitBatch(owner, []);
  }

  /**
   * Resolves a lookup by its canonical kind.
   * @param kind - Canonical lookup kind.
   * @returns The registered lookup, or `undefined` when not registered.
   */
  public get(kind: string): LookupContribution | undefined {
    return this.core.get(kind);
  }

  /**
   * Lists every registered lookup across every owner.
   * @returns A live snapshot array of every registered lookup.
   */
  public list(): readonly LookupContribution[] {
    return this.core.list();
  }

  /**
   * Lists the registered lookups with their owners.
   * @returns An owned contribution snapshot.
   */
  public listOwned(): ReadonlyArray<{ extension: string; entry: LookupContribution }> {
    return this.core.listOwned();
  }

  /** Removes every registered lookup, from every owner. */
  public clear(): void {
    this.core.clear();
  }
}

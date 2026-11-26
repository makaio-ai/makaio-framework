import { ExtensionNameSchema, localContributionName } from '@makaio/core';
import type { FixedOperationContribution, FixedOperationPhase } from '@makaio/contracts/extension';
import { FixedOperationError, type FixedOperationGeneration } from './fixed-operation-invocation.js';

export interface FixedOperationCatalogEntry {
  readonly phase: FixedOperationPhase;
  readonly extension: string;
}

const admissionBrand = Symbol('FixedOperationAdmission');

/** Opaque, non-serializable snapshot valid for one run on the host that issued it. */
export type FixedOperationAdmission = { readonly [admissionBrand]: true };

/** Operation metadata and the identities checked by a workflow admission. */
export interface FixedOperationCatalog {
  readonly entries: Readonly<Record<string, FixedOperationCatalogEntry>>;
  readonly admission: FixedOperationAdmission;
}

export interface RegisteredOperation extends FixedOperationContribution, FixedOperationCatalogEntry {
  readonly isActive: () => boolean;
  readonly generation: FixedOperationGeneration;
}

type OperationGroups = readonly (readonly RegisteredOperation[])[];

/** Store admission identities privately and let abandoned tokens be collected. */
export class FixedOperationAdmissions {
  private readonly snapshots = new WeakMap<FixedOperationAdmission, OperationGroups>();

  /**
   * Capture the registrations used for a workflow load check.
   * @param groups - Active registrations in dependency order.
   * @returns Immutable catalog metadata and its opaque token.
   */
  public capture(groups: OperationGroups): FixedOperationCatalog {
    const admission = Object.freeze({ [admissionBrand]: true as const });
    const entries = Object.freeze(
      Object.fromEntries(
        groups.flat().map(({ name, extension, phase }) => [name, Object.freeze({ extension, phase })]),
      ),
    );
    this.snapshots.set(admission, groups);
    return Object.freeze({ entries, admission });
  }

  /**
   * Consume a snapshot issued by this registry.
   * @param admission - Token supplied by the caller.
   * @returns Exactly the registrations visible at admission.
   */
  public consume(admission: FixedOperationAdmission): OperationGroups {
    const groups = this.snapshots.get(admission);
    if (groups === undefined) throw new FixedOperationError('inactive-registration', 'registration');
    this.snapshots.delete(admission);
    return groups;
  }
}

/**
 * Admit a contribution only under the identity of its verified extension.
 * @param extension - Verified owner name.
 * @param operation - Contribution supplied by that owner.
 * @param names - Names already registered.
 * @param sources - Owners that already supply a source phase.
 * @returns A validated registration.
 */
export function validateRegistration(
  extension: string,
  operation: FixedOperationContribution,
  names: Set<string>,
  sources: Set<string>,
): Omit<RegisteredOperation, 'isActive' | 'generation'> {
  const { name, phase, applies, run, requiresVerifiedSource } = operation;
  if (!ExtensionNameSchema.safeParse(extension).success || typeof applies !== 'function' || typeof run !== 'function') {
    throw new FixedOperationError('invalid-registration', 'registration');
  }
  if (typeof name !== 'string' || localContributionName(extension, name) === undefined || name.endsWith('.')) {
    throw new FixedOperationError('foreign-owner', 'registration');
  }
  if (phase !== 'workflow-source' && phase !== 'before-steps' && phase !== 'after-steps') {
    throw new FixedOperationError('invalid-registration', 'registration');
  }
  if (names.has(name)) throw new FixedOperationError('duplicate-operation', 'registration');
  names.add(name);
  if (phase === 'workflow-source') {
    if (sources.has(extension)) throw new FixedOperationError('duplicate-source', 'registration');
    sources.add(extension);
  }
  if (
    Object.prototype.toString.call(applies) === '[object AsyncFunction]' ||
    (requiresVerifiedSource !== undefined && (requiresVerifiedSource !== true || phase !== 'after-steps'))
  ) {
    throw new FixedOperationError('invalid-registration', 'registration');
  }
  return { extension, name, phase, applies, run, requiresVerifiedSource };
}

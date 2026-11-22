import type { ContributionName, Party } from '@makaio/core';
import type { EdgeName, SubjectName } from './identifiers.js';
import type { WitnessedAccount } from './witnessed-account.js';

/**
 * An inbound edge: the way events of one external system come in (a webhook
 * route, a poll, an event stream). It belongs to the extension that knows that
 * system.
 */
export interface InboundEdgeContribution {
  /** Name of the edge, owned by the contributing extension. */
  readonly edge: EdgeName;
  /** What the edge receives and from where, for people. */
  readonly description: string;
  /**
   * The recorded subjects this edge accepts. Each must be owned by the same
   * extension and be a recorded event.
   */
  readonly subjects: readonly SubjectName[];
  /**
   * Types of objects of the external system that the events of this edge
   * address. Open values declared by the extension.
   */
  readonly objectTypes?: readonly string[];
}

/**
 * Maps a witnessed account to a party of the host. The core keeps no register
 * of accounts and only calls this contribution. At most one active extension
 * contributes a resolver.
 */
export interface AccountResolverContribution {
  /** Name of the resolver, owned by the contributing extension. */
  readonly resolver: ContributionName;
  /** What the resolver maps accounts against, for people. */
  readonly description: string;
  /**
   * Resolve a witnessed account to a party of the host. Only reads, and is
   * never called inside a transaction of the host's database.
   * @param account - The witnessed account to map.
   * @returns The party the account maps to, or `null` when the account is not mapped to any party of the host.
   */
  resolve(account: WitnessedAccount): Promise<Party | null>;
}

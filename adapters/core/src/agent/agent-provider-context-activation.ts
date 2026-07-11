import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderContext } from '@makaio/contracts';
import {
  prepareProviderContextActivation,
  type ProviderContextActivationTransaction,
} from '@makaio/services-core/provider-context';

/**
 * Own one prepared native-account activation until exactly one terminal action.
 *
 * The account-manager lock is acquired before connector construction. Commit is
 * delayed until the replacement is initialized and ready for synchronous
 * publication; every earlier failure rolls the selection back.
 */
export class AgentProviderContextActivation {
  private terminal = false;

  private constructor(private readonly transaction: ProviderContextActivationTransaction | undefined) {}

  /**
   * Prepare the selected managed account, if the provider context requires one.
   * @param bus - Host-local bus owning account-manager transactions
   * @param providerContext - Provider context selected for the replacement
   * @returns Prepared activation owner, including a no-op owner for non-managed auth
   */
  public static async prepare(
    bus: IMakaioBus,
    providerContext: ProviderContext,
  ): Promise<AgentProviderContextActivation> {
    return new AgentProviderContextActivation(await prepareProviderContextActivation(bus, providerContext));
  }

  /** Commit the prepared account immediately before connector publication. */
  public async commit(): Promise<void> {
    if (this.transaction === undefined) return;
    try {
      await this.transaction.commit();
    } finally {
      // A commit attempt is terminal: the account manager performs its own
      // rollback when commit cannot persist the prepared native state.
      this.terminal = true;
    }
  }

  /** Roll back a prepared account that has not reached a commit attempt. */
  public async rollbackPending(): Promise<void> {
    if (this.transaction === undefined || this.terminal) return;
    try {
      await this.transaction.rollback();
    } finally {
      this.terminal = true;
    }
  }
}

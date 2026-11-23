import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderContext } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
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
   * @param call - Call context of the message requesting activation
   * @param bus - Host-local bus owning account-manager transactions
   * @param providerContext - Provider context selected for the replacement
   * @returns Prepared activation owner, including a no-op owner for non-managed auth
   */
  public static async prepare(
    call: CallContext,
    bus: IMakaioBus,
    providerContext: ProviderContext,
  ): Promise<AgentProviderContextActivation> {
    return new AgentProviderContextActivation(await prepareProviderContextActivation(call, bus, providerContext));
  }

  /**
   * Commit the prepared account immediately before connector publication.
   * @param call - Call context of the message requesting commit
   */
  public async commit(call: CallContext): Promise<void> {
    if (this.transaction === undefined) return;
    try {
      await this.transaction.commit(call);
    } finally {
      // A commit attempt is terminal: the account manager performs its own
      // rollback when commit cannot persist the prepared native state.
      this.terminal = true;
    }
  }

  /**
   * Roll back a prepared account that has not reached a commit attempt.
   * @param call - Call context of the message whose activation failed
   */
  public async rollbackPending(call: CallContext): Promise<void> {
    if (this.transaction === undefined || this.terminal) return;
    try {
      await this.transaction.rollback(call);
    } finally {
      this.terminal = true;
    }
  }
}

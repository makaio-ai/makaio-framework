import { ClientSubjects } from '@makaio/contracts/client';
import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { Account } from '../bus/schemas.js';
import type { IAccountMetadataStore } from '../interfaces/account-store.js';
import { buildClientAccountObserveRequest } from '../client-account-observation.js';

/**
 * Dependencies injected into {@link ClientAccountLinker}.
 */
export interface ClientAccountLinkerDeps {
  /** Bus instance used for optional clients-core observation requests. */
  bus: IMakaioBus;
  /** Public account metadata persistence layer. */
  metadataStore: IAccountMetadataStore;
  /** Client IDs owned by the running account-manager sources. */
  clientIds: ReadonlyArray<string>;
}

/**
 * Keeps optional `linkedClientAccountId` rows aligned with clients-core.
 *
 * Linking is best-effort: when `client.account.observe` is not handled or no
 * canonical identifiers can be derived from account metadata, local accounts
 * remain unlinked.
 */
export class ClientAccountLinker {
  private readonly cleanups: Array<() => void> = [];

  public constructor(private readonly deps: ClientAccountLinkerDeps) {}

  /**
   * Subscribes to account-manager lifecycle events that can improve linking.
   */
  public start(): void {
    this.cleanups.push(
      this.deps.bus.on(AccountManagerSubjects.credentials.detected, async (ctx) => {
        await this.observeAccount(ctx.payload.clientId, ctx.payload.account);
      }),
      this.deps.bus.on(AccountManagerSubjects.credentials.refreshed, async (ctx) => {
        await this.observeAccount(ctx.payload.clientId, ctx.payload.account);
      }),
      this.deps.bus.on(AccountManagerSubjects.credentials.switched, async (ctx) => {
        await this.observeAccount(ctx.payload.clientId, ctx.payload.to);
      }),
      this.deps.bus.on(AccountManagerSubjects.accounts.labeled, async (ctx) => {
        await this.observeAccount(ctx.payload.clientId, ctx.payload.account);
      }),
    );
  }

  /**
   * Unsubscribes from all bus listeners.
   */
  public stop(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
  }

  /**
   * Backfills clients-core links for already-persisted accounts.
   */
  public async syncExistingAccounts(): Promise<void> {
    for (const clientId of this.deps.clientIds) {
      const accounts = await this.deps.metadataStore.list(clientId);
      for (const account of accounts) {
        await this.observeAccount(clientId, account);
      }
    }
  }

  private async observeAccount(clientId: string, account: Account): Promise<void> {
    const request = buildClientAccountObserveRequest(clientId, account);
    if (!request) {
      return;
    }

    const result = await this.observeClientAccount(request);
    if (!result || account.linkedClientAccountId === result.clientAccountId) {
      return;
    }

    try {
      await this.deps.metadataStore.setLinkedClientAccountId(clientId, account.id, result.clientAccountId);
    } catch (error) {
      console.error(
        `[ClientAccountLinker] Failed to persist linked client account for ${clientId}:${account.id}:`,
        error,
      );
    }
  }

  /**
   * Resolve a local account into the clients-core canonical account registry.
   * @param request - Client account observation request built from local metadata
   * @returns Canonical clients-core account ID, or null when unavailable
   */
  private async observeClientAccount(
    request: NonNullable<ReturnType<typeof buildClientAccountObserveRequest>>,
  ): Promise<{ clientAccountId: string } | null> {
    try {
      const result = await this.deps.bus.requestOptional(ClientSubjects.account.observe, request);
      return result.handled ? result.data : null;
    } catch {
      // Best-effort linkage; later credential or label events can retry when
      // clients-core observation is temporarily unavailable.
      return null;
    }
  }
}

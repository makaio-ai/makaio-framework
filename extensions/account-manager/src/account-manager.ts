import { BaseService } from '@makaio/service-base';
import { AccountManagerSubjects } from './bus/namespace.js';
import { UsageHistoryRequestSchema } from './bus/schemas.js';
import { CredentialSubjects } from '@makaio/contracts';
import type { ExtensionWarning } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import type { UsageEntry } from './bus/usage-entry.js';
import type {
  IAccountCredentialStore,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
} from './interfaces/account-store.js';
import { toPublicAccount } from './utils/index.js';
import { emitCredentialChangedForClient } from './credential-lifecycle.js';
import { ACCOUNT_MANAGER_ID } from './account-manager-id.js';
import {
  ClientAccountLinker,
  CredentialTracker,
  LabelResolver,
  UsageTracker,
  WindowActivator,
  DEFAULT_POLL_INTERVAL_MS,
} from './handlers/index.js';
import type { CredentialSourceWithOptionalLabel } from './handlers/index.js';
import { getStoredAccount, listStoredAccounts, removeStoredAccount } from './storage/joined-account-store.js';
import { buildLabelSources, buildUsageSources } from './source-capability-maps.js';
import { collectAccountManagerHealthWarnings } from './health-warnings.js';
import { AccountManagerQuiesceError, hasEnabledAutoActivationSource } from './account-manager-types.js';
import type { AccountManagerOptions } from './account-manager-types.js';
import { switchAccount, activateAccount, prepareAccountActivation } from './account-activation.js';
import { AccountActivationTransactions } from './account-activation-transactions.js';
import { prepareUsageCredential } from './account-usage-credential.js';
import { registerAccountManagerSourceHandlers } from './account-manager-source-handlers.js';
import { ClientMutationQueue } from './client-mutation-queue.js';

export type { AccountManagerOptions };

/**
 * Multi-account credential manager for AI coding tools.
 *
 * Detects credential changes in installed AI tools, builds a multi-account
 * store per tool, and enables switching the active account with a single command.
 *
 * Runs as a BaseService inside the Makaio Node runtime. Orchestrates four
 * handler modules:
 * - {@link CredentialTracker} — polls sources and emits credential events
 * - {@link LabelResolver} — resolves and persists account labels
 * - {@link UsageTracker} — fetches volatile usage data and handles `usage.get`
 * - {@link WindowActivator} — sends ephemeral pings when usage windows reset
 *   (optional, enabled via `options.autoActivation`)
 *
 * Registers bus handlers for account listing, switching, labeling, and removal.
 */
export class AccountManager extends BaseService {
  private readonly sources: CredentialSourceWithOptionalLabel[];
  private readonly credentialStore: IAccountCredentialStore;
  private readonly metadataStore: IAccountMetadataStore;
  private readonly usageSnapshotStore: IAccountUsageSnapshotStore | undefined;
  private readonly pollIntervalMs: number;
  private readonly makaioCommand: string;

  /** Serializes multi-step mutations per client so active-account state stays coherent. */
  private readonly clientMutations = new ClientMutationQueue();

  /** Owns prepared account switches through one terminal action or shutdown. */
  private readonly activationTransactions: AccountActivationTransactions;

  private readonly credentialTracker: CredentialTracker;
  private readonly clientAccountLinker: ClientAccountLinker;
  private readonly labelResolver: LabelResolver;
  private readonly usageTracker: UsageTracker;
  private readonly windowActivator: WindowActivator | undefined;

  /**
   * @param bus - Bus instance for handler registration and event emission
   * @param options - Service configuration
   */
  public constructor(bus: IMakaioBus, options: AccountManagerOptions) {
    super(bus);
    this.sources = options.sources;
    this.credentialStore = options.credentialStore;
    this.metadataStore = options.metadataStore;
    this.usageSnapshotStore = options.usageSnapshotStore;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.makaioCommand = options.makaioCommand;

    const labelSources = buildLabelSources(this.sources);
    const usageSources = buildUsageSources(this.sources);

    this.credentialTracker = new CredentialTracker({
      bus,
      sources: this.sources,
      credentialStore: this.credentialStore,
      metadataStore: this.metadataStore,
      withClientMutation: (clientId, action) => this.clientMutations.run(clientId, action),
      pollIntervalMs: this.pollIntervalMs,
    });

    this.clientAccountLinker = new ClientAccountLinker({
      bus,
      metadataStore: this.metadataStore,
      clientIds: this.sources.map((source) => source.clientId),
    });

    this.labelResolver = new LabelResolver({
      bus,
      sources: labelSources,
      credentialStore: this.credentialStore,
      metadataStore: this.metadataStore,
    });

    this.usageTracker = new UsageTracker({
      bus,
      sources: usageSources,
      credentialStore: this.credentialStore,
      metadataStore: this.metadataStore,
      usageSnapshotStore: this.usageSnapshotStore,
      pollIntervalMs: options.usagePollIntervalMs,
      sourceConfigs: options.usageSourceConfigs,
      readCredential: async (clientId, accountId) =>
        prepareUsageCredential(clientId, accountId, this.getSource(clientId), this.metadataStore, this.credentialStore),
    });

    this.activationTransactions = new AccountActivationTransactions({
      clientMutations: this.clientMutations,
      prepareActivation: async (clientId, accountId) => {
        const target = await getStoredAccount(this.metadataStore, this.credentialStore, clientId, accountId);
        return target === null
          ? null
          : prepareAccountActivation(clientId, accountId, this.buildActivationDeps(clientId), undefined, target);
      },
    });

    if (hasEnabledAutoActivationSource(options.autoActivation)) {
      this.windowActivator = new WindowActivator(bus, options.autoActivation);
    }
  }

  protected async onInit(): Promise<void> {
    this.clientAccountLinker.start();
    this.addCleanup(() => this.clientAccountLinker.stop());
    this.labelResolver.start();
    this.addCleanup(() => this.labelResolver.stop());
    this.usageTracker.start();
    this.addCleanup(() => this.usageTracker.requestStop());
    if (this.windowActivator) {
      const { windowActivator } = this;
      windowActivator.start();
      this.addCleanup(() => windowActivator.stop());
    }
    this.registerHandlers();
    this.addCleanup(
      registerAccountManagerSourceHandlers({
        bus: this.bus,
        sources: this.sources,
        withClientMutation: (clientId, action) => this.clientMutations.run(clientId, action),
      }),
    );
    this.registerCredentialLifecycleHandlers();
    await this.credentialTracker.start();
    this.addCleanup(() => this.credentialTracker.stop());
    this.addCleanup(() => this.usageTracker.stop());
    await this.clientAccountLinker.syncExistingAccounts();
    this.usageTracker.bootstrap();
    // Admission opens only after every fallible initialization step. BaseService
    // does not call onDestroy when onInit rejects, so opening earlier could leave
    // a prepared transaction waiting forever after handler cleanup.
    this.activationTransactions.start();
  }

  /** Roll back every unconsumed activation before service-owned handlers are removed. */
  protected override async onDestroy(): Promise<void> {
    this.usageTracker.requestStop();
    await this.activationTransactions.shutdown();
  }

  /**
   * Registers the primary bus handlers.
   */
  private registerHandlers(): void {
    this.registerHandler(AccountManagerSubjects.accounts.list, async (ctx) => {
      const accounts = await this.clientMutations.run(ctx.payload.clientId, async () =>
        listStoredAccounts(this.metadataStore, this.credentialStore, ctx.payload.clientId),
      );
      ctx.setResult({ accounts: accounts.map(toPublicAccount) });
    });

    this.registerHandler(AccountManagerSubjects.accounts.getActive, async (ctx) => {
      const active = await this.clientMutations.run(ctx.payload.clientId, async () =>
        this.metadataStore.getActive(ctx.payload.clientId),
      );
      ctx.setResult({ account: active });
    });

    this.registerHandler(AccountManagerSubjects.accounts.getActiveAtTimestamp, async (ctx) => {
      const accountId = await this.metadataStore.getActiveAtTimestamp(ctx.payload.clientId, ctx.payload.timestamp);
      ctx.setResult({ accountId });
    });

    this.registerHandler(AccountManagerSubjects.credentials.switch, async (ctx) => {
      try {
        const activatedAccountId = await this.clientMutations.run(ctx.payload.clientId, async () =>
          switchAccount(ctx.payload.clientId, ctx.payload.accountId, this.buildActivationDeps(ctx.payload.clientId)),
        );
        // Credential fanout runs outside the mutation lock — see poll() comment.
        if (activatedAccountId !== undefined) {
          await emitCredentialChangedForClient(this.bus, ctx.payload.clientId, activatedAccountId);
        }
        ctx.setResult({ success: true });
      } catch (error) {
        if (error instanceof AccountManagerQuiesceError) {
          await error.quiesce;
        }
        ctx.setResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.registerHandler(AccountManagerSubjects.accounts.label, async (ctx) => {
      await this.clientMutations.run(ctx.payload.clientId, async () => {
        const { clientId, accountId, label } = ctx.payload;
        const account = await this.metadataStore.setLabel(clientId, accountId, label);
        if (!account) {
          ctx.setResult({ success: false });
          return;
        }
        ctx.setResult({ success: true });
      });
    });

    this.registerHandler(AccountManagerSubjects.accounts.remove, async (ctx) => {
      const quiesceFactory = await this.clientMutations.run(ctx.payload.clientId, async () => {
        const { clientId, accountId } = ctx.payload;
        // Fetch before removal so we can compare the fingerprint below.
        const accountToRemove = await this.credentialStore.get(clientId, accountId);
        await removeStoredAccount(this.metadataStore, this.credentialStore, clientId, accountId);
        // Clear cached state so the next poll re-detects this credential
        // if the user logs in again after removal.
        return accountToRemove ? () => this.clearDerivedState(clientId, accountId, accountToRemove.fingerprint) : null;
      });
      if (quiesceFactory) {
        await quiesceFactory();
      }
      ctx.setResult({ success: true });
    });

    this.registerHandler(AccountManagerSubjects.usage.history, async (ctx) => {
      // Re-parse with the shared schema so isolated test/runtime bus instances
      // keep the same request contract even when namespace validation is not
      // wired into that specific bus context.
      const { clientId, accountId, windowId, from, to } = UsageHistoryRequestSchema.parse(ctx.payload);
      if (!this.usageSnapshotStore) {
        ctx.setResult({ entries: [] });
        return;
      }
      // The request schema already bounds the time window to the analytics UI's
      // supported ranges. This handler still materializes the full match set
      // because the contract returns `entries: UsageEntry[]`; if history ever
      // needs pagination, that belongs in the subject contract and callers,
      // not as an ad-hoc truncation here.
      const entries: UsageEntry[] = [];
      try {
        for await (const entry of this.usageSnapshotStore.read(clientId, accountId, { from, to, windowId })) {
          entries.push(entry);
        }
      } catch (error) {
        // Re-throw so the bus dispatcher wraps this into a RequestError for
        // the caller, consistent with how other failing handlers are surfaced.
        throw error instanceof Error ? error : new Error(String(error));
      }
      ctx.setResult({ entries });
    });
  }

  /**
   * Report integration health warnings after startup.
   * @returns Active health warnings, one per affected source or integration issue.
   */
  public async checkHealth(): Promise<ExtensionWarning[]> {
    const makaioCommand = typeof this.makaioCommand === 'string' ? this.makaioCommand.trim() : '';
    if (makaioCommand.length === 0) {
      throw new Error('AccountManager.checkHealth requires a host-provided launcher command.');
    }
    return collectAccountManagerHealthWarnings(this.bus, this.sources, { makaioCommand });
  }

  /**
   * Registers integration hooks for the credential activation/rotation flow.
   */
  private registerCredentialLifecycleHandlers(): void {
    this.registerHandler(CredentialSubjects.activate, async (ctx) => {
      const { providerContext } = ctx.payload;
      if (providerContext.auth.mode !== 'inferred' || providerContext.auth.account === undefined) {
        await ctx.next();
        return;
      }

      const { account, method } = providerContext.auth;
      if (account.managerId !== ACCOUNT_MANAGER_ID) {
        await ctx.next();
        return;
      }

      let quiesce: Promise<void> | undefined;
      const result = await this.clientMutations.run(method.clientId, async () => {
        try {
          const target = await getStoredAccount(
            this.metadataStore,
            this.credentialStore,
            method.clientId,
            account.accountId,
          );
          if (!target) {
            return { success: false as const, code: 'account-not-found' as const };
          }
          await activateAccount(
            method.clientId,
            account.accountId,
            this.buildActivationDeps(method.clientId),
            undefined,
            target,
          );
          return { success: true as const };
        } catch (error) {
          if (error instanceof AccountManagerQuiesceError) {
            quiesce = error.quiesce;
          }
          return { success: false as const, code: 'activation-failed' as const };
        }
      });
      if (quiesce) {
        await quiesce.catch(() => undefined);
      }
      ctx.setResult(result);
    });

    this.registerHandler(CredentialSubjects.activation.prepare, async (ctx) => {
      const { providerContext } = ctx.payload;
      if (providerContext.auth.mode !== 'inferred' || providerContext.auth.account === undefined) {
        await ctx.next();
        return;
      }
      const { account, method } = providerContext.auth;
      if (account.managerId !== ACCOUNT_MANAGER_ID) {
        await ctx.next();
        return;
      }
      ctx.setResult(await this.activationTransactions.prepare(method.clientId, account.accountId));
    });

    this.registerHandler(CredentialSubjects.activation.commit, async (ctx) => {
      ctx.setResult(await this.activationTransactions.commit(ctx.payload.transactionId));
    });

    this.registerHandler(CredentialSubjects.activation.rollback, async (ctx) => {
      ctx.setResult(await this.activationTransactions.rollback(ctx.payload.transactionId));
    });
  }

  /**
   * Builds the activation dependency bundle for a given client.
   *
   * Binds the client's source, store references, and tracker callbacks into the
   * shape expected by {@link switchAccount} and {@link activateAccount}.
   * @param clientId - The client identifier
   * @returns Activation dependencies for the given client
   */
  private buildActivationDeps(clientId: string) {
    return {
      metadataStore: this.metadataStore,
      credentialStore: this.credentialStore,
      source: this.getSource(clientId),
      setLastSeen: (cid: string, fingerprint: string) => this.credentialTracker.setLastSeen(cid, fingerprint),
      clearDerivedState: (cid: string, accountId: string, fingerprint: string) =>
        this.clearDerivedState(cid, accountId, fingerprint),
      bus: this.bus,
    };
  }

  /**
   * Clears derived-state caches for a removed account.
   *
   * Shared by the `accounts.remove` handler and zombie pruning in
   * {@link activateAccount} so both paths stay in sync.
   * @param clientId - Client whose caches should be cleared
   * @param accountId - Account being removed
   * @param fingerprint - Fingerprint of the removed account
   * @returns Promise that settles once account-owned tracker work has drained
   */
  private clearDerivedState(clientId: string, accountId: string, fingerprint: string): Promise<void> {
    if (this.credentialTracker.getLastSeen(clientId) === fingerprint) {
      this.credentialTracker.deleteLastSeen(clientId);
    }
    this.labelResolver.clearRetryState(clientId, accountId);
    this.usageTracker.clearAccountState(clientId, accountId);
    return this.usageTracker.waitForAccountQuiescence(clientId, accountId);
  }

  /**
   * Retrieves the credential source for a client.
   * @param clientId - The client identifier
   * @returns The matching credential source
   * @throws Error if no source found for the clientId
   */
  private getSource(clientId: string): CredentialSourceWithOptionalLabel {
    const source = this.sources.find((s) => s.clientId === clientId);
    if (!source) throw new Error(`No credential source found for ${clientId}`);
    return source;
  }
}

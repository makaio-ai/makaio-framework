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
import {
  emitCredentialChangedForClient,
  isAccountManagerManagedProviderConfig,
  parseAccountManagerRef,
  resolveClientByDefinitionId,
} from './credential-lifecycle.js';
import {
  ClientAccountLinker,
  CredentialTracker,
  LabelResolver,
  UsageTracker,
  WindowActivator,
  DEFAULT_POLL_INTERVAL_MS,
} from './handlers/index.js';
import type { CredentialSourceWithOptionalLabel } from './handlers/index.js';
import { listStoredAccounts, removeStoredAccount } from './storage/joined-account-store.js';
import { buildLabelSources, buildUsageSources } from './source-capability-maps.js';
import { collectAccountManagerHealthWarnings } from './health-warnings.js';
import { AccountManagerQuiesceError, hasEnabledAutoActivationSource } from './account-manager-types.js';
import type { AccountManagerOptions } from './account-manager-types.js';
import { switchAccount, activateAccount } from './account-activation.js';
import { prepareUsageCredential } from './account-usage-credential.js';

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
  private readonly clientMutations = new Map<string, Promise<void>>();

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
      withClientMutation: (clientId, action) => this.withClientMutation(clientId, action),
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
    this.registerSourceHandlers();
    this.registerConfigurationHandlers();
    this.registerCredentialLifecycleHandlers();
    await this.credentialTracker.start();
    this.addCleanup(() => this.credentialTracker.stop());
    this.addCleanup(() => this.usageTracker.stop());
    await this.clientAccountLinker.syncExistingAccounts();
    this.usageTracker.bootstrap();
  }

  /**
   * Registers the primary bus handlers.
   */
  private registerHandlers(): void {
    this.registerHandler(AccountManagerSubjects.accounts.list, async (ctx) => {
      const accounts = await this.withClientMutation(ctx.payload.clientId, async () =>
        listStoredAccounts(this.metadataStore, this.credentialStore, ctx.payload.clientId),
      );
      ctx.setResult({ accounts: accounts.map(toPublicAccount) });
    });

    this.registerHandler(AccountManagerSubjects.accounts.getActive, async (ctx) => {
      const active = await this.withClientMutation(ctx.payload.clientId, async () =>
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
        const activatedAccountId = await this.withClientMutation(ctx.payload.clientId, async () =>
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
      await this.withClientMutation(ctx.payload.clientId, async () => {
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
      const quiesceFactory = await this.withClientMutation(ctx.payload.clientId, async () => {
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
   * Registers the source-discovery handler.
   *
   * Per-source try/catch ensures one failing source (e.g. locked keychain)
   * degrades gracefully instead of breaking the entire getSources RPC.
   */
  private registerSourceHandlers(): void {
    this.registerHandler(AccountManagerSubjects.accounts.getSources, async (ctx) => {
      const sources = await Promise.all(
        this.sources.map(async (source) => {
          try {
            const available = await source.isAvailable();
            const result: {
              clientId: string;
              displayName: string;
              available: boolean;
              configIssue?: { reason: string; action: string };
            } = {
              clientId: source.clientId,
              displayName: source.displayName,
              available,
            };

            if (available && source.getConfigIssue) {
              const issue = await source.getConfigIssue();
              if (issue) {
                result.configIssue = issue;
              }
            }

            return result;
          } catch (error) {
            return {
              clientId: source.clientId,
              displayName: source.displayName,
              available: false,
              configIssue: {
                reason: error instanceof Error ? error.message : String(error),
                action: 'Verify that this credential source is accessible and try again.',
              },
            };
          }
        }),
      );
      ctx.setResult({ sources });
    });
  }

  /**
   * Reports integration health warnings after startup.
   *
   * Inspects each credential source and returns an {@link ExtensionWarning} for
   * sources that are not installed, have a correctable configuration issue, or
   * have incomplete integration wiring. An unavailable source (tool not installed)
   * produces an `'info'` warning; an installed but misconfigured or unwired
   * source produces a `'recommended'` warning with a `configure-integration`
   * action so the UI can route the user directly to integration settings.
   * @returns Active health warnings, one per affected source/integration issue.
   */
  public async checkHealth(): Promise<ExtensionWarning[]> {
    const makaioCommand = typeof this.makaioCommand === 'string' ? this.makaioCommand.trim() : '';
    if (makaioCommand.length === 0) {
      throw new Error('AccountManager.checkHealth requires a host-provided launcher command.');
    }
    return collectAccountManagerHealthWarnings(this.bus, this.sources, { makaioCommand });
  }

  /** Registers source-configuration handlers. */
  private registerConfigurationHandlers(): void {
    this.registerHandler(AccountManagerSubjects.credentials.configureFileMode, async (ctx) => {
      try {
        await this.withClientMutation(ctx.payload.clientId, async () => {
          const source = this.getSource(ctx.payload.clientId);
          if (!source.configureFileMode) {
            throw new Error(`configureFileMode is not supported for ${ctx.payload.clientId}`);
          }
          // Source-owned config mutation keeps tool-specific path logic in one
          // place instead of splitting it between source and service layers.
          await source.configureFileMode();
        });
        ctx.setResult({ success: true });
      } catch (error) {
        ctx.setResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Registers integration hooks for the credential activation/rotation flow.
   */
  private registerCredentialLifecycleHandlers(): void {
    this.registerHandler(CredentialSubjects.activate, async (ctx) => {
      const refs = Object.values(ctx.payload.credentialRefs);
      const targetRef = refs
        .map((ref) => parseAccountManagerRef(ref))
        .find((parsed): parsed is { clientId: string; accountId: string } => parsed !== null);

      if (targetRef) {
        await this.withClientMutation(targetRef.clientId, async () => {
          await activateAccount(targetRef.clientId, targetRef.accountId, this.buildActivationDeps(targetRef.clientId));
        });
        ctx.setResult({});
        return;
      }

      // definitionId fallback: when no account-manager ref is present in credentialRefs,
      // resolve by provider definition so the native credential store stays in sync
      // whenever any adapter for this provider type starts up — regardless of which
      // config triggered activation.
      if (!(await isAccountManagerManagedProviderConfig(this.bus, ctx.payload.providerConfigId))) {
        ctx.setResult({});
        return;
      }

      const client = await resolveClientByDefinitionId(this.bus, ctx.payload.definitionId);
      if (!client?.defaultProviderId) {
        ctx.setResult({});
        return;
      }

      await this.withClientMutation(client.id, async () => {
        const active = await this.metadataStore.getActive(client.id);
        if (!active?.id) {
          return;
        }
        await activateAccount(client.id, active.id, this.buildActivationDeps(client.id));
      });
      ctx.setResult({});
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

  /**
   * Serializes multi-step mutations per client.
   *
   * Store implementations defend their own files, but the service also needs a
   * higher-level lock so poll, switch, label, and remove do not interleave
   * active-account transitions against different snapshots.
   * @param clientId - Client whose mutation queue should be used
   * @param action - Workflow to run exclusively for that client
   * @returns The workflow result
   */
  private async withClientMutation<T>(clientId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.clientMutations.get(clientId) ?? Promise.resolve();
    const run = previous.then(action, action);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.clientMutations.set(clientId, settled);
    try {
      return await run;
    } finally {
      if (this.clientMutations.get(clientId) === settled) {
        this.clientMutations.delete(clientId);
      }
    }
  }
}

import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { ILabelProvider } from '../interfaces/label-provider.js';
import type { IAccountCredentialStore, IAccountMetadataStore } from '../interfaces/account-store.js';
import type { Account } from '../bus/schemas.js';

/** Minimum interval between label resolution retries for unlabeled accounts. */
const LABEL_RETRY_INTERVAL_MS = 60_000;

/**
 * A credential source identified by clientId that can resolve labels.
 */
export interface LabelSource extends ILabelProvider {
  /** Stable client identifier, e.g. 'claude-code'. */
  readonly clientId: string;
}

/**
 * Dependencies injected into {@link LabelResolver}.
 */
export interface LabelResolverDeps {
  /** Bus instance for subscribing to events and emitting labeled events. */
  bus: IMakaioBus;
  /**
   * Map from clientId to the label-capable source for that client.
   *
   * Only clients whose source implements {@link ILabelProvider} are included.
   */
  sources: Map<string, LabelSource>;
  /** Credential persistence layer. */
  credentialStore: IAccountCredentialStore;
  /** Public metadata persistence layer. */
  metadataStore: IAccountMetadataStore;
}

/**
 * Owns the `accounts.labeled` subject.
 *
 * Subscribes to `credentials.detected`, `credentials.refreshed`, and
 * `credentials.switched` events. For detected events that carry an inline
 * label attempt (`autoLabeled` present) this handler owns only later retries.
 * For switched events it re-resolves whenever the label was cleared (e.g. due
 * to an identity change). On each eligible event, attempts to resolve a
 * human-readable label for the account using the source's
 * {@link ILabelProvider.resolveLabel}. Once a label is resolved it is
 * persisted and `accounts.labeled` is emitted; retries are throttled to
 * {@link LABEL_RETRY_INTERVAL_MS}.
 */
export class LabelResolver {
  private readonly bus: IMakaioBus;
  private readonly sources: Map<string, LabelSource>;
  private readonly credentialStore: IAccountCredentialStore;
  private readonly metadataStore: IAccountMetadataStore;

  /** Tracks last resolveLabel attempt per `${clientId}:${accountId}` to throttle retries. */
  private readonly labelRetryAt = new Map<string, number>();

  private readonly cleanups: Array<() => void> = [];

  /**
   * @param deps - Injected dependencies
   */
  public constructor(deps: LabelResolverDeps) {
    this.bus = deps.bus;
    this.sources = deps.sources;
    this.credentialStore = deps.credentialStore;
    this.metadataStore = deps.metadataStore;
  }

  /**
   * Subscribes to credential events and begins label resolution.
   */
  public start(): void {
    this.cleanups.push(
      this.bus.on(AccountManagerSubjects.credentials.detected, async (ctx) => {
        // New-account detection already performs one inline best-effort label
        // attempt before publishing credentials.detected. When `autoLabeled`
        // is present, this handler owns only later retries, not the same-turn
        // first attempt.
        if (ctx.payload.autoLabeled !== undefined) {
          // Only record a retry deadline when this client has a label-capable
          // source — otherwise the entry can never be consumed by the retry
          // sweep, leading to unbounded map growth across detections for
          // sources that never implement `resolveLabel`.
          if (ctx.payload.autoLabeled === false && this.sources.has(ctx.payload.clientId)) {
            this.labelRetryAt.set(`${ctx.payload.clientId}:${ctx.payload.account.id}`, Date.now());
          }
          return;
        }
        await this.handleCredentialEvent(ctx.payload.clientId, ctx.payload.account);
      }),
      this.bus.on(AccountManagerSubjects.credentials.refreshed, async (ctx) => {
        await this.handleCredentialEvent(ctx.payload.clientId, ctx.payload.account);
      }),
      this.bus.on(AccountManagerSubjects.credentials.switched, async (ctx) => {
        const { clientId, to } = ctx.payload;
        // Only re-resolve when the label was cleared (e.g. by an identity change
        // detected during a known-account switch). If the label is already present,
        // no work is needed and handleCredentialEvent would skip it anyway.
        if (to.label) return;
        // Clear any prior retry throttle so a freshly-switched account is not
        // suppressed by a failed lookup that occurred while it was inactive.
        this.clearRetryState(clientId, to.id);
        await this.handleCredentialEvent(clientId, to);
      }),
    );
  }

  /**
   * Unsubscribes from all bus events.
   */
  public stop(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
  }

  /**
   * Clears the retry state for a specific account.
   *
   * Called by {@link AccountManager} when an account is removed so the next
   * detection of that fingerprint is not suppressed.
   * @param clientId - Client identifier
   * @param accountId - Account identifier
   */
  public clearRetryState(clientId: string, accountId: string): void {
    this.labelRetryAt.delete(`${clientId}:${accountId}`);
  }

  /**
   * Attempts label resolution for the given account if the source supports it.
   * @param clientId - Client identifier for store operations
   * @param publicAccount - The public account snapshot from the bus event
   */
  private async handleCredentialEvent(clientId: string, publicAccount: Account): Promise<void> {
    // Skip accounts that are already labeled — label resolution stops once resolved.
    if (publicAccount.label) return;

    const source = this.sources.get(clientId);
    if (!source) return;

    const key = `${clientId}:${publicAccount.id}`;
    const lastAttempt = this.labelRetryAt.get(key) ?? 0;
    if (Date.now() - lastAttempt < LABEL_RETRY_INTERVAL_MS) return;

    // Set timestamp before the async call to prevent overlapping retries.
    this.labelRetryAt.set(key, Date.now());

    try {
      const [metadata, credential] = await Promise.all([
        this.metadataStore.get(clientId, publicAccount.id),
        this.credentialStore.get(clientId, publicAccount.id),
      ]);
      if (!metadata || !credential || metadata.label) {
        // Already labeled in store (set by another path) — clear retry state.
        if (metadata?.label) {
          this.labelRetryAt.delete(key);
        }
        return;
      }

      const label = await source.resolveLabel(credential.credential);
      if (label) {
        const updated = await this.metadataStore.setLabel(clientId, publicAccount.id, label);
        if (!updated) {
          return;
        }
        // Once labeled, clear retry state — no further retries needed.
        this.labelRetryAt.delete(key);

        await this.bus.emit(AccountManagerSubjects.accounts.labeled, {
          clientId,
          account: updated,
        });
      }
    } catch {
      // Label resolution is best-effort — next event will retry after the interval.
    }
  }
}

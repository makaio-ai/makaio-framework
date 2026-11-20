import fs from 'node:fs/promises';
import type { IDirectChannel, IMakaioBus } from '@makaio/bus-core';
import { openChannel, ChannelClosedError } from '@makaio/bus-core';
import type { CredentialRef } from '@makaio/contracts/config';
import { parseStoredCredentialRef } from '@makaio/contracts/config';
import { CredentialSubjects } from '@makaio/contracts';
import type { CredentialResolver } from '@makaio/contracts/extension';
import { resolveCredentialRef } from '@makaio/ai-adapters-core/config';
import { launch as realLaunch, launchForOutput, type LaunchFunction } from '@makaio/subprocess';

/**
 * Credential provider for resolving credential references.
 *
 * Alias of {@link CredentialResolver} from `@makaio/contracts/extension` — the
 * contracts interface is the authoritative shape; this alias keeps existing
 * consumers that import from the runtime package working without duplication.
 */
export type CredentialProvider = CredentialResolver;

/** Longest run time of one keychain lookup. */
const KEYCHAIN_TIMEOUT_MS = 10_000;
/** Longest captured keychain output (a credential is short). */
const KEYCHAIN_OUTPUT_LIMIT_BYTES = 64 * 1024;

/** Options of {@link NodeCredentialProvider}. */
export interface NodeCredentialProviderOptions {
  /** Process start for the keychain lookup; defaults to the real `launch`. */
  readonly launch?: LaunchFunction;
}

/**
 * Node.js credential provider.
 *
 * Resolves env:, file:, and keychain: credential references.
 */
export class NodeCredentialProvider implements CredentialProvider {
  private readonly launch: LaunchFunction;

  /**
   * Create a provider.
   * @param options - Optional process start for the keychain lookup
   */
  public constructor(options: NodeCredentialProviderOptions = {}) {
    this.launch = options.launch ?? realLaunch;
  }

  /**
   * Resolve a credential reference to its plaintext value.
   *
   * Returns null (never throws) for `stored:` refs — those require a
   * credential service handler registered on the bus. Returns null (never
   * throws) for `file:` refs that are missing or unreadable.
   * @param ref - Credential reference (`env:`, `file:`, or `keychain:`)
   * @returns Resolved credential value, or null when unavailable
   */
  public async resolve(ref: CredentialRef): Promise<string | null> {
    if (ref.startsWith('stored:')) {
      console.warn(
        `[NodeCredentialProvider] Cannot resolve "stored:" credential ref "${ref}": ` +
          `Register a credential service handler on this host to enable stored credential resolution.`,
      );
      return null;
    }
    return resolveCredentialRef(ref, {
      resolveKeychain: (service, account) => this.resolveKeychain(service, account),
      readFile: async (path) => {
        try {
          return await fs.readFile(path, 'utf-8');
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? 'unknown error';
          console.warn(`[NodeCredentialProvider] Cannot read file credential at "${path}" (${code}). Returning null.`);
          // Return an empty string so resolveCredentialRef's `.trim() || null` yields null.
          return '';
        }
      },
    });
  }

  private async resolveKeychain(service: string, account: string): Promise<string | null> {
    // The output is a credential: it is returned to the caller only, never logged.
    const outcome = await launchForOutput(
      {
        command: 'security',
        cwd: process.cwd(),
        args: ['find-generic-password', '-s', service, '-a', account, '-w'],
        envMode: 'merge',
        timeoutMs: KEYCHAIN_TIMEOUT_MS,
        outputLimitBytes: KEYCHAIN_OUTPUT_LIMIT_BYTES,
      },
      this.launch,
    );
    return outcome.ok ? outcome.stdout.trim() || null : null;
  }
}

/**
 * Credential provider that resolves stored refs via credential service.
 *
 * Falls back to NodeCredentialProvider for env/file/keychain refs.
 * Uses a lazy-opened DirectChannel for the channel-only `credential.get` subject.
 */
export class StoredCredentialProvider implements CredentialProvider {
  private readonly fallbackProvider = new NodeCredentialProvider();
  /**
   * Lazily-opened channel to the credentials endpoint.
   *
   * Only set when a channel is successfully open. Cleared when the service is
   * absent (null return), on open failures, and on `ChannelClosedError` so
   * every subsequent call re-checks the bus via `requestOptional`.
   * Call {@link close} during host shutdown to release the channel explicitly.
   */
  private channelPromise?: Promise<IDirectChannel | null>;

  /**
   * Create a new stored credential provider.
   * @param bus - Bus instance for credential retrieval
   */
  public constructor(private readonly bus: IMakaioBus) {}

  /**
   * Resolve a credential reference, including stored refs.
   *
   * Handles the `stored:providerConfig:<configId>:<key>` format via
   * `CredentialSubjects.get` over an encrypted DirectChannel. Falls back to
   * NodeCredentialProvider for env:, file:, and keychain: refs.
   * @param ref - Credential reference to resolve
   * @returns Resolved credential value, or null when unavailable
   */
  public async resolve(ref: CredentialRef): Promise<string | null> {
    const parsed = parseStoredCredentialRef(ref);
    if (parsed) {
      const { configId, key } = parsed;
      // Retry once on ChannelClosedError: clear the stale cached channel and
      // re-open transparently so callers never see transient channel lifecycle failures.
      //
      // This retry-once pattern parallels RelayConnectionService.withCredentialChannel().
      // Both are kept local because they live in different host/runtime packages,
      // and the pattern is simple enough that a shared abstraction
      // would add indirection without meaningful DRY benefit.
      for (let attempt = 0; attempt < 2; attempt++) {
        // Capture the promise used this iteration so we only clear the cache
        // when it still holds the stale entry — a concurrent caller may have
        // already replaced it with a fresh channel.
        const channelPromise = this.getChannel();
        try {
          const channel = await channelPromise;
          if (!channel) {
            // No credential service handler is registered (e.g. headless host
            // without a product credential service). Degrade gracefully.
            console.warn(
              `[StoredCredentialProvider] Cannot resolve "stored:" credential ref "${ref}": ` +
                `Register a credential service handler on this host to enable stored credential resolution.`,
            );
            return null;
          }
          const result = await channel.request(CredentialSubjects.get, { configId });
          return result.credentials?.[key] ?? null;
        } catch (e) {
          if (e instanceof ChannelClosedError) {
            if (this.channelPromise === channelPromise) {
              this.channelPromise = undefined;
            }
            if (attempt === 0) continue;
          }
          throw e;
        }
      }
    }

    // Guard against stale persisted credential refs that used the removed
    // `stored:adapter:` format. `parseStoredCredentialRef` only handles the
    // current `stored:providerConfig:` format, so any other `stored:` prefix
    // is unresolvable. Warn and return null so callers can surface the error.
    if (ref.startsWith('stored:')) {
      console.warn(
        `[StoredCredentialProvider] Unresolvable credential ref "${ref}". ` +
          `Only the "stored:providerConfig:" format is supported. ` +
          `Re-save the credential using the current format.`,
      );
      return null;
    }

    return this.fallbackProvider.resolve(ref);
  }

  /**
   * Close and discard the cached channel. Safe to call multiple times (idempotent).
   *
   * Call during host shutdown before the bus/transport is torn down so the
   * channel is released cleanly rather than abandoned.
   */
  public close(): void {
    const stale = this.channelPromise;
    this.channelPromise = undefined;
    if (stale !== undefined) {
      void stale
        .then((ch) => {
          ch?.close();
        })
        .catch(() => {
          // Channel was never successfully opened or is already closed — nothing to do.
        });
    }
  }

  /**
   * Lazily open (and cache) the encrypted channel to the credentials endpoint.
   *
   * Only a successfully opened channel is cached. When the service is absent
   * (`openCredentialChannel` returns `null`), the promise is cleared so the
   * next call re-checks via `requestOptional` — the service may have registered
   * since this call. Open failures are also cleared so the next call retries
   * rather than re-using a permanently-rejected promise.
   * @returns The open DirectChannel, or null when no handler is registered
   */
  private getChannel(): Promise<IDirectChannel | null> {
    this.channelPromise ??= this.openCredentialChannel().then(
      (ch) => {
        // The credential service is not yet registered. Clear the cached promise
        // so the next call re-checks via requestOptional — the service may have
        // registered since. Only a successfully opened channel is kept in cache.
        if (ch === null) {
          this.channelPromise = undefined;
        }
        return ch;
      },
      (error) => {
        this.channelPromise = undefined;
        throw error;
      },
    );
    return this.channelPromise;
  }

  /**
   * Open a fresh encrypted channel to the credentials endpoint.
   *
   * Returns null when no `getChannelToken` handler is registered on the bus
   * (optional service — the credential service is not always present).
   * @returns Newly opened DirectChannel, or null when the service is absent
   */
  private async openCredentialChannel(): Promise<IDirectChannel | null> {
    const result = await this.bus.requestOptional(CredentialSubjects.getChannelToken, {});
    if (!result.handled) {
      return null;
    }
    const { token } = result.data;
    return openChannel(this.bus.getContext(), 'credentials', { token, transports: [] });
  }
}

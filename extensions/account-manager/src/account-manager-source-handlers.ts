import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from './bus/namespace.js';
import type { CredentialSourceWithOptionalLabel } from './handlers/index.js';

/** Dependencies for account source discovery and configuration handlers. */
export interface AccountManagerSourceHandlerDeps {
  /** Bus on which account-manager source subjects are registered. */
  readonly bus: IMakaioBus;
  /** Client credential sources surfaced by discovery. */
  readonly sources: readonly CredentialSourceWithOptionalLabel[];
  /** Per-client mutation serializer owned by the account manager. */
  readonly withClientMutation: <T>(clientId: string, action: () => Promise<T>) => Promise<T>;
}

/**
 * Register source discovery and source-owned configuration handlers.
 * @param deps - Bus, sources, and mutation serializer.
 * @returns Cleanup callback that unregisters every handler.
 */
export function registerAccountManagerSourceHandlers(deps: AccountManagerSourceHandlerDeps): () => void {
  const getSource = (clientId: string): CredentialSourceWithOptionalLabel => {
    const source = deps.sources.find((candidate) => candidate.clientId === clientId);
    if (!source) throw new Error(`Unknown client: ${clientId}`);
    return source;
  };

  const cleanups: Array<() => void> = [];
  try {
    cleanups.push(
      deps.bus.on(AccountManagerSubjects.accounts.getSources, async (ctx) => {
        const sources = await Promise.all(
          deps.sources.map(async (source) => {
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
                if (issue) result.configIssue = issue;
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
      }),
    );
    cleanups.push(
      deps.bus.on(AccountManagerSubjects.credentials.configureFileMode, async (ctx) => {
        try {
          await deps.withClientMutation(ctx.payload.clientId, async () => {
            const source = getSource(ctx.payload.clientId);
            if (!source.configureFileMode) {
              throw new Error(`configureFileMode is not supported for ${ctx.payload.clientId}`);
            }
            await source.configureFileMode();
          });
          ctx.setResult({ success: true });
        } catch (error) {
          ctx.setResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  } catch (error) {
    for (const cleanup of cleanups) cleanup();
    throw error;
  }

  return () => cleanups.forEach((cleanup) => cleanup());
}

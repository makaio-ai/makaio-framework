/**
 * Contribution processor for the client hook response surface.
 *
 * Binds extension-declared {@link ExtensionClientHookResponsesContribution}
 * to the {@link ClientHookResponseRegistry} lifecycle: activation installs
 * a validated contributor batch atomically; deactivation removes the
 * extension's contributors; shutdown clears all registrations.
 * @packageDocumentation
 */

import type {
  ContributorActivationContext,
  ContributorDefinition,
  ProviderContractCatalogEntry,
} from '@makaio/contracts/client';
import type { ContributionProcessor } from '@makaio/kernel';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import type { ClientHookProviderContractRegistry } from './client-hook-provider-contract-registry.js';
import type { ClientHookResponseRegistry } from './client-hook-response-registry.js';

/**
 * Create a {@link ContributionProcessor} that wires
 * {@link ExtensionClientHookResponsesContribution} into the
 * {@link ClientHookResponseRegistry} during extension lifecycle events.
 *
 * The returned processor:
 * - **Filters** to extensions that declare `clientHookResponses`.
 * - **Activation:** calls `createContributors(ctx)`, validates the batch
 *   against the provider contract registry, and installs atomically. On
 *   validation failure, throws a descriptive error so the coordinator
 *   transitions the extension to `failed`.
 * - **Deactivation (stopped):** removes the extension's contributors from
 *   the registry. Errors propagate to the coordinator.
 * - **Shutdown:** call `processStopped` per extension; the coordinator
 *   handles this via reverse-order teardown.
 *
 * The processor performs its own rollback before throwing: if
 * `createContributors` succeeds but `installContributors` fails, no
 * partial state leaks into the registry.
 * @param responseRegistry - Registry that stores contributor definitions.
 * @param contractRegistry - Provider contract registry for activation-time
 *   validation and activation context lookups.
 * @returns A `ContributionProcessor` ready for registration with the
 *   extension coordinator.
 */
export function createClientHookResponseContributionProcessor(
  responseRegistry: ClientHookResponseRegistry,
  contractRegistry: ClientHookProviderContractRegistry,
): ContributionProcessor {
  return {
    filter: (pkg: KernelMakaioExtension): boolean => !!pkg.clientHookResponses,

    async processActivated(name: string, pkg: KernelMakaioExtension, ctx: KernelExtensionContext): Promise<void> {
      const contribution = pkg.clientHookResponses;
      if (!contribution) return;

      // Build the activation context for the factory.
      const activationCtx: ContributorActivationContext<KernelExtensionContext> = {
        extensionName: name,
        extensionContext: ctx,
        getProviderContract: (clientId: string, contractId: string): ProviderContractCatalogEntry | undefined =>
          contractRegistry.getProviderContract(clientId, contractId),
      };

      // Await the factory — it may be sync or async.
      let definitions: ContributorDefinition[];
      try {
        definitions = await contribution.createContributors(activationCtx);
      } catch (factoryError: unknown) {
        throw new Error(
          `[ClientHookResponseContributionProcessor] ` +
            `createContributors failed for '${name}': ` +
            `${factoryError instanceof Error ? factoryError.message : String(factoryError)}`,
          { cause: factoryError },
        );
      }

      // Validate and install atomically.
      const result = responseRegistry.installContributors(name, definitions);
      if (result.errors.length > 0) {
        const summary = result.errors
          .map((e) => `[${e.code}] ${e.contributorId ?? '<unknown>'}: ${e.message}`)
          .join('; ');
        throw new Error(
          `[ClientHookResponseContributionProcessor] ` + `Contributor validation failed for '${name}': ${summary}`,
        );
      }
    },

    async processStopped(name: string): Promise<void> {
      responseRegistry.removeContributors(name);
    },
  };
}

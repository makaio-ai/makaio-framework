import type { ProviderDefinitionInput, ProviderContext } from '@makaio/contracts';
import { CredentialRefSchema } from '@makaio/contracts/config';
import type { CreateTestAgentOptions } from '../types/index.js';
import type { ScopedBus } from '@makaio/bus-core';

/** Fields injected by resolveTestConfig */
type InjectedTestFields<TBus extends ScopedBus<string>> = {
  agentId: string;
  adapterId: string;
  adapterName: string;
  bus: TBus;
  /**
   * Unresolved provider context for conformance tests.
   *
   * When a `testProviderDefinition` is supplied, credential refs are built
   * from the definition's `credentialEnvVars` mapping using `env:VAR_NAME`
   * format. Connectors resolve these refs locally via `resolveConnectorCredentials()`
   * — which reads from `process.env` for `env:` refs — mirroring the full
   * credential-resolution chain without requiring a database or bus handlers.
   *
   * Falls back to a minimal sentinel (empty `credentialRefs`) when no definition
   * is provided.
   */
  providerContext: ProviderContext;
};

/** Result type: options merged with injected fields (handles undefined options) */
type ResolvedTestConfig<TOptions, TBus extends ScopedBus<string>> = (TOptions extends undefined ? object : TOptions) &
  InjectedTestFields<TBus>;

/** Sentinel provider config ID used in test contexts where no real config exists. */
const TEST_PROVIDER_CONFIG_ID = 'test-provider-config-id';

/**
 * Collect credential env var names declared by provider definitions.
 * @param definitions - Provider definitions to inspect
 * @returns Unique credential env var names
 */
function collectCredentialEnvVars(definitions: readonly ProviderDefinitionInput[]): string[] {
  return [
    ...new Set(
      definitions.flatMap((definition) =>
        definition.credentialEnvVars ? Object.values(definition.credentialEnvVars) : [],
      ),
    ),
  ];
}

/**
 * Build an unresolved provider context for conformance tests.
 *
 * When a provider definition is supplied, builds credential refs in `env:VAR_NAME`
 * format from `credentialEnvVars`. Connectors resolve these refs locally via
 * `resolveConnectorCredentials()`. Otherwise returns a minimal sentinel.
 * @param definition - Optional provider definition to build credential refs from
 * @param ambientCredentialDefinitions - Provider definitions whose credential
 *   env vars should be stripped from ambient subprocess environments
 * @returns Fresh unresolved provider context per call to prevent cross-test mutation leaks
 */
export function createTestProviderContext(
  definition?: ProviderDefinitionInput,
  ambientCredentialDefinitions: readonly ProviderDefinitionInput[] = definition ? [definition] : [],
): ProviderContext {
  const credentialRefs: Record<string, ReturnType<typeof CredentialRefSchema.parse>> = {};
  const ambientCredentialEnvVars = collectCredentialEnvVars(ambientCredentialDefinitions);

  if (definition?.credentialEnvVars) {
    for (const [field, envVar] of Object.entries(definition.credentialEnvVars)) {
      credentialRefs[field] = CredentialRefSchema.parse(`env:${envVar}`);
    }
  }

  return {
    providerConfigId: TEST_PROVIDER_CONFIG_ID,
    definitionId: definition?.id ?? 'test',
    credentialRefs,
    ...(definition?.credentialEnvVars ? { credentialEnvVars: { ...definition.credentialEnvVars } } : undefined),
    ...(ambientCredentialEnvVars.length > 0 ? { ambientCredentialEnvVars } : {}),
    ...(definition?.endpoints ? { endpointOverrides: { ...definition.endpoints } } : {}),
  };
}

/**
 * Resolves test configuration by adding required fields (bus, agentId, adapterId, adapterName, providerContext).
 *
 * When `testProviderDefinition` is supplied, credential refs and endpoint overrides
 * are built from the definition's `credentialEnvVars` and `endpoints` — so
 * conformance tests can run against real providers without the full orchestrator.
 * @param options - Partial test agent options (undefined = empty config)
 * @param bus - Scoped bus instance for the adapter
 * @param testProviderDefinition - Optional provider definition for credential ref building
 * @param ambientCredentialDefinitions - Provider definitions whose credential
 *   env vars should be stripped from ambient subprocess environments
 * @returns Complete test config with required fields injected
 */
export function resolveTestConfig<TOptions extends CreateTestAgentOptions | undefined, TBus extends ScopedBus<string>>(
  options: TOptions,
  bus: TBus,
  testProviderDefinition?: ProviderDefinitionInput,
  ambientCredentialDefinitions: readonly ProviderDefinitionInput[] = testProviderDefinition
    ? [testProviderDefinition]
    : [],
): ResolvedTestConfig<TOptions, TBus> {
  return {
    ...options,
    bus,
    agentId: crypto.randomUUID(),
    adapterId: crypto.randomUUID(),
    adapterName: options?.adapterName ?? 'test-adapter',
    providerContext:
      options?.providerContext ?? createTestProviderContext(testProviderDefinition, ambientCredentialDefinitions),
  } as ResolvedTestConfig<TOptions, TBus>;
}

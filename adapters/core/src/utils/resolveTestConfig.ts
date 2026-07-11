import { ProviderContextSchema } from '@makaio/contracts';
import type {
  AdapterProviderAuth,
  AdapterProviderRef,
  ProtocolId,
  ProviderDefinitionInput,
  ProviderContext,
} from '@makaio/contracts';
import { AuthCredentialRefSchema } from '@makaio/contracts/auth';
import type { CreateTestAgentOptions } from '../types/index.js';
import type { ScopedBus } from '@makaio/bus-core';

/** Fields injected by resolveTestConfig */
type InjectedTestFields<TBus extends ScopedBus<string>> = {
  agentId: string;
  adapterId: string;
  adapterName: string;
  bus: TBus;
  /**
   * Refs-only normalized provider context for conformance tests.
   *
   * A missing definition or auth method remains the closed unresolved state.
   */
  providerContext: ProviderContext;
  /** Exact selected adapter/provider protocol for endpoint resolution. */
  providerProtocol?: ProtocolId;
  /** Exact selected adapter/provider auth declaration. */
  adapterProviderAuth?: AdapterProviderAuth;
  /** Other compatible auth declarations contributing to environment scrubbing. */
  compatibleProviderAuths: AdapterProviderAuth[];
};

/** Result type: options merged with injected fields (handles undefined options) */
type TestConfigOptionsInput = Omit<CreateTestAgentOptions, 'providerContext'> & { providerContext?: unknown };

type ResolvedTestConfig<TBus extends ScopedBus<string>> = Omit<TestConfigOptionsInput, 'providerContext'> &
  InjectedTestFields<TBus>;

/** Provider config ID used in definition-backed test contexts. */
const TEST_PROVIDER_CONFIG_ID = 'test-provider-config-id';

/**
 * Build a normalized provider context for conformance tests.
 *
 * Explicit fields use their first declared environment source hint. Definitions
 * without a selectable provider-owned method remain unresolved; tests for
 * client-owned auth provide a context explicitly.
 * @param definition - Optional provider definition to build credential refs from
 * @returns Fresh refs-only provider context per call.
 */
export function createTestProviderContext(definition?: ProviderDefinitionInput): ProviderContext {
  if (!definition) {
    return { state: 'unresolved' };
  }

  const method = (definition.authMethods ?? []).find(({ mode }) => mode === 'explicit' || mode === 'none');
  if (!method) {
    return { state: 'unresolved' };
  }

  const base = {
    state: 'resolved' as const,
    providerConfigId: TEST_PROVIDER_CONFIG_ID,
    definitionId: definition.id,
    ...(definition.endpoints ? { endpointOverrides: { ...definition.endpoints } } : {}),
    ...(definition.capabilities ? { capabilities: structuredClone(definition.capabilities) } : {}),
  };

  if (method.mode === 'none') {
    return {
      ...base,
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: definition.id, methodId: method.id },
        definition: { ...method },
      },
    };
  }

  const credentialEntries = method.fields.flatMap((field) => {
    const source = field.sourceHints.find(({ kind }) => kind === 'environment');
    if (!source && field.required) {
      throw new Error(`Conformance auth method "${method.id}" field "${field.id}" has no environment source hint.`);
    }
    return source ? [[field.id, AuthCredentialRefSchema.parse(`env:${source.variable}`)] as const] : [];
  });
  const credentialRefs = Object.fromEntries(credentialEntries);
  return {
    ...base,
    auth: {
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: definition.id, methodId: method.id },
      definition: structuredClone(method),
      credentialRefs,
    },
  };
}

/**
 * Resolves test configuration by adding required fields (bus, agentId, adapterId, adapterName, providerContext).
 *
 * When `testProviderDefinition` is supplied, normalized auth refs and endpoint overrides
 * are built from the definition's auth methods and endpoints — so
 * conformance tests can run against real providers without the full orchestrator.
 * @param options - Partial test agent options (undefined = empty config)
 * @param bus - Scoped bus instance for the adapter
 * @param testProviderDefinition - Optional provider definition for credential ref building
 * @param adapterProviderRefs - Exact adapter/provider declarations under test
 * @returns Complete test config with required fields injected
 */
export function resolveTestConfig<TBus extends ScopedBus<string>>(
  options: TestConfigOptionsInput | undefined,
  bus: TBus,
  testProviderDefinition?: ProviderDefinitionInput,
  adapterProviderRefs: readonly AdapterProviderRef[] = [],
): ResolvedTestConfig<TBus> {
  const providerContext =
    options?.providerContext === undefined
      ? createTestProviderContext(testProviderDefinition)
      : ProviderContextSchema.parse(options.providerContext);
  const selectedProviderRef =
    providerContext.state === 'resolved'
      ? adapterProviderRefs.find(({ definitionId }) => definitionId === providerContext.definitionId)
      : undefined;
  const compatibleProviderAuths = adapterProviderRefs.flatMap((ref) =>
    ref !== selectedProviderRef && ref.auth !== undefined ? [ref.auth] : [],
  );
  const { providerContext: _rawProviderContext, ...runtimeOptions } = options ?? {};
  return {
    ...runtimeOptions,
    bus,
    agentId: crypto.randomUUID(),
    adapterId: crypto.randomUUID(),
    adapterName: options?.adapterName ?? 'test-adapter',
    providerContext,
    ...(selectedProviderRef?.protocol !== undefined && { providerProtocol: selectedProviderRef.protocol }),
    ...(selectedProviderRef?.auth !== undefined && { adapterProviderAuth: selectedProviderRef.auth }),
    compatibleProviderAuths,
  };
}

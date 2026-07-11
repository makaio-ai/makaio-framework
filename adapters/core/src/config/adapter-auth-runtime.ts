import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import { ClientSubjects, type ClientExecutionContext } from '@makaio/contracts/client';
import type { BaseAgentConnectorConfig } from '../agent/types.js';
import {
  AdapterAuthError,
  type BoundProviderAuthContext,
  getOptionalAuthCredentialFields,
  type ResolvedAdapterAuth,
  resolveBoundProviderAuth,
} from './resolve-adapter-auth.js';
import { ConnectorCredentialResolutionError, resolveConnectorCredentials } from './resolve-connector-credentials.js';
import { resolveSessionEnvironment } from './resolve-session-environment.js';

/** Refs-only config emitted by the common adapter factory. */
export type BoundAdapterRuntimeConfig<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus> = BaseAgentConnectorConfig<TBus>,
> = TConfig & {
  /** Adapter instance identifier required by connector factories. */
  adapterId: string;
  /** Exact normalized auth selection and adapter delivery binding. */
  boundProviderAuth?: BoundProviderAuthContext;
};

/** Connector-facing config after auth refs and client state have been materialized. */
export type ResolvedAdapterRuntimeConfig<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus> = BaseAgentConnectorConfig<TBus>,
> = Omit<TConfig, 'boundProviderAuth'> & {
  /** Adapter instance identifier required by connector factories. */
  adapterId: string;
  /** Selected connector-local auth delivery, including plaintext. */
  adapterAuth?: ResolvedAdapterAuth;
  /** Selected managed client binary, when this adapter has a client. */
  clientExecution?: ClientExecutionContext;
  /** Auth-free environment safe for routable/shared execution contexts. */
  contextEnv: Readonly<Record<string, string>>;
};

/** Explicit connector-owned client config lease. */
export interface AdapterAuthLeaseHandle {
  /** Client whose isolated config directory is leased. */
  readonly clientId: string;
  /** Connector-unique lease identifier. */
  readonly leaseId: string;
  /** Release the lease exactly once. Repeated calls share the same result. */
  release(): Promise<void>;
}

/** Runtime config plus the lease whose lifetime must match its connector. */
export interface PreparedAdapterAuthRuntime<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus> = BaseAgentConnectorConfig<TBus>,
> {
  /** Connector-facing config with one immutable auth snapshot. */
  readonly config: ResolvedAdapterRuntimeConfig<TBus, TConfig>;
  /** Explicit lease handle, present only for client-backed adapters. */
  readonly lease?: AdapterAuthLeaseHandle;
}

/** Trusted non-serializable strategy for preparing auth in the current host. */
export type AdapterAuthRuntimePreparer<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus> = BaseAgentConnectorConfig<TBus>,
> = (config: BoundAdapterRuntimeConfig<TBus, TConfig>) => Promise<PreparedAdapterAuthRuntime<TBus, TConfig>>;

/** Host-resolved auth material supplied to a runtime without local secret services. */
export interface SuppliedAdapterAuthRuntime {
  /** Auth snapshot already compiled against the selected adapter binding by the host. */
  readonly selectorValidatedAuth: ResolvedAdapterAuth;
  /** Complete host-compiled adapter auth source/sink scrub union. */
  readonly scrubEnvVars: readonly string[];
  /** Non-auth session environment supplied by the host. */
  readonly sessionEnv?: Readonly<Record<string, string>>;
  /** Pre-resolved non-auth binary environment supplied by the host. */
  readonly binaryEnv?: Readonly<Record<string, string>>;
  /** Environment for an externally-owned config lease or mounted native state. */
  readonly leaseEnv?: Readonly<Record<string, string>>;
}

/** Lease material returned while preparing one connector. */
interface CreatedAuthLease {
  readonly handle: AdapterAuthLeaseHandle;
  readonly env: Readonly<Record<string, string>>;
  readonly authMaterialized: boolean;
}

/**
 * Bus-backed lease handle with idempotent release semantics.
 */
class BusAdapterAuthLeaseHandle implements AdapterAuthLeaseHandle {
  private releasePromise: Promise<void> | undefined;

  public constructor(
    private readonly bus: IMakaioBus,
    public readonly clientId: string,
    public readonly leaseId: string,
  ) {}

  /**
   * Release this lease once and share the in-flight result with repeated callers.
   * @returns Shared lease-destruction result
   */
  public release(): Promise<void> {
    this.releasePromise ??= this.destroy();
    return this.releasePromise;
  }

  /** Destroy the leased session config and reject an unsuccessful response. */
  private async destroy(): Promise<void> {
    const result = await this.bus.request(ClientSubjects.sessionConfig.destroy, {
      clientId: this.clientId,
      leaseId: this.leaseId,
    });
    if (!result.success) {
      throw new Error('Client config lease release was unsuccessful.');
    }
  }
}

/**
 * Prepare the single connector-local auth snapshot and client config lease.
 *
 * Explicit credential refs are resolved exactly once through the encrypted
 * credential channel. The existing session-environment helper remains the
 * sole merge authority: it scrubs the full adapter set before selected auth
 * values are applied last. The caller owns the returned lease and must release
 * it in every connector close or rollback path.
 * @param config - Refs-only config emitted by the adapter config factory
 * @returns Connector-facing config and its explicit lease handle
 */
export async function prepareAdapterAuthRuntime<
  TBus extends ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus>,
>(config: BoundAdapterRuntimeConfig<TBus, TConfig>): Promise<PreparedAdapterAuthRuntime<TBus, TConfig>> {
  const bound = config.boundProviderAuth;
  if (bound === undefined) {
    const contextEnv = Object.freeze({ ...(config.env ?? {}) });
    return { config: { ...config, env: Object.freeze({ ...contextEnv }), contextEnv } };
  }

  const globalBus = requireRuntimeBus(config.globalBus);
  validateRuntimeClient(bound, config.clientId);
  const adapterAuth = await resolveBoundProviderAuth(bound, async (refs) => {
    try {
      return await resolveConnectorCredentials(globalBus, refs, {
        optionalFields: getOptionalAuthCredentialFields(bound),
      });
    } catch (error) {
      if (error instanceof ConnectorCredentialResolutionError && error.code === 'credential-unavailable') {
        throw new AdapterAuthError('credential-missing', 'A required authentication credential is unavailable.');
      }
      throw error;
    }
  });
  const createdLease = await createAuthLease(globalBus, config, adapterAuth);

  try {
    assertNativeAuthMaterialized(bound, createdLease);
    const environment = await resolveSessionEnvironment({
      globalBus,
      clientId: config.clientId,
      baseEnv: config.env,
      scrubEnvVars: bound.scrubEnvVars,
      leaseEnv: createdLease?.env,
      selectedAuthEnv: adapterAuth.processEnv,
    });
    const { boundProviderAuth: _boundProviderAuth, ...connectorConfig } = config;
    return {
      config: {
        ...connectorConfig,
        env: environment.connectorEnv,
        contextEnv: environment.contextEnv,
        adapterAuth,
        ...(environment.resolvedBinary !== undefined && { clientExecution: environment.resolvedBinary }),
      },
      ...(createdLease !== undefined && { lease: createdLease.handle }),
    };
  } catch (error) {
    await releaseAfterFailure(createdLease?.handle, error, 'Adapter auth preparation and lease rollback both failed.');
    throw error;
  }
}

/**
 * Apply host-resolved auth without opening credential channels or owning leases.
 *
 * This is the container/bootstrap seam. Its input must already have been
 * selector-validated with {@link resolveBoundProviderAuth} by the trusted host.
 * Every supplied non-auth source is merged before the full scrub union, then
 * only the selected process delivery is injected. Connector deliveries remain
 * structured values and are never serialized or logged here.
 * @param config - Connector config containing only non-auth runtime inputs
 * @param supplied - Host-compiled auth and non-auth environment sources
 * @returns Connector-facing config with one immutable auth snapshot
 */
export async function applySuppliedAdapterAuthRuntime<
  TBus extends ScopedBus<string>,
  TConfig extends BaseAgentConnectorConfig<TBus>,
>(
  config: BoundAdapterRuntimeConfig<TBus, TConfig>,
  supplied: SuppliedAdapterAuthRuntime,
): Promise<ResolvedAdapterRuntimeConfig<TBus, TConfig>> {
  const adapterAuth = freezeSuppliedAdapterAuth(supplied.selectorValidatedAuth);
  const environment = await resolveSessionEnvironment({
    baseEnv: config.env,
    sessionEnv: supplied.sessionEnv,
    binaryEnv: supplied.binaryEnv,
    leaseEnv: supplied.leaseEnv,
    scrubEnvVars: supplied.scrubEnvVars,
    selectedAuthEnv: adapterAuth.processEnv,
  });
  const { boundProviderAuth: _boundProviderAuth, ...connectorConfig } = config;
  return {
    ...connectorConfig,
    env: environment.connectorEnv,
    contextEnv: environment.contextEnv,
    adapterAuth,
  };
}

/**
 * Require the global bus for secret resolution and lease ownership.
 * @param bus - Bus carried by the connector config
 * @returns The required global bus
 */
function requireRuntimeBus(bus: IMakaioBus | undefined): IMakaioBus {
  if (bus === undefined) {
    throw new AdapterAuthError('runtime-bus-missing', 'Normalized adapter authentication requires a global bus.');
  }
  return bus;
}

/**
 * Enforce owner-qualified client identity before any credential materialization.
 * @param bound - Exact provider/auth binding
 * @param runtimeClientId - Client selected by the adapter runtime
 */
function validateRuntimeClient(bound: BoundProviderAuthContext, runtimeClientId: string | undefined): void {
  const method = bound.auth.method;
  if (method.owner === 'client' && method.clientId !== runtimeClientId) {
    throw new AdapterAuthError(
      'client-mismatch',
      'Selected authentication client does not match the adapter runtime client.',
    );
  }
}

/**
 * Create one connector-unique auth lease for a client-backed adapter.
 * @param bus - Global runtime bus
 * @param config - Connector runtime config
 * @param auth - Resolved connector-local auth delivery
 * @returns Lease material, or undefined for adapters without a client
 */
async function createAuthLease<TBus extends ScopedBus<string>>(
  bus: IMakaioBus,
  config: BoundAdapterRuntimeConfig<TBus>,
  auth: ResolvedAdapterAuth,
): Promise<CreatedAuthLease | undefined> {
  if (config.clientId === undefined) {
    return undefined;
  }

  const leaseId = crypto.randomUUID();
  const result = await bus.request(ClientSubjects.sessionConfig.create, {
    clientId: config.clientId,
    leaseId,
    ...(config.sessionId !== undefined && { ownerSessionId: config.sessionId }),
    ...(config.clientProfileName !== undefined && { profileName: config.clientProfileName }),
    projectDir: config.cwd,
    configInheritance: auth.configInheritance,
  });
  return {
    handle: new BusAdapterAuthLeaseHandle(bus, config.clientId, leaseId),
    env: Object.freeze({ ...result.env }),
    authMaterialized: result.authMaterialized,
  };
}

/**
 * Reject inferred auth when the client could not materialize native state.
 * @param bound - Exact normalized auth selection
 * @param lease - Created client lease, when client-backed
 */
function assertNativeAuthMaterialized(bound: BoundProviderAuthContext, lease: CreatedAuthLease | undefined): void {
  if (bound.auth.mode === 'inferred' && lease?.authMaterialized !== true) {
    throw new AdapterAuthError(
      'native-auth-unavailable',
      'Selected native client authentication could not be materialized.',
    );
  }
}

/**
 * Release a partially-created lease without hiding either failure.
 * @param lease - Lease to release, when one was created
 * @param primaryError - Failure that triggered rollback
 * @param message - Aggregate diagnostic when rollback also fails
 */
async function releaseAfterFailure(
  lease: AdapterAuthLeaseHandle | undefined,
  primaryError: unknown,
  message: string,
): Promise<void> {
  if (lease === undefined) {
    return;
  }
  try {
    await lease.release();
  } catch (releaseError) {
    throw new AggregateError([primaryError, releaseError], message, { cause: primaryError });
  }
}

/**
 * Clone and freeze a host-supplied auth snapshot without stringifying it.
 * @param auth - Selector-validated host auth snapshot
 * @returns Immutable connector-local snapshot
 */
function freezeSuppliedAdapterAuth(auth: ResolvedAdapterAuth): ResolvedAdapterAuth {
  const connectorDeliveries = auth.connectorDeliveries.map((delivery) =>
    Object.freeze({
      target: delivery.target,
      values: Object.freeze({ ...delivery.values }),
    }),
  );
  return Object.freeze({
    processEnv: Object.freeze({ ...auth.processEnv }),
    connectorDeliveries: Object.freeze(connectorDeliveries),
    configInheritance: auth.configInheritance,
  });
}

import {
  AdapterProviderAuthSchema,
  ResolvedProviderAuthSchema,
  assertAdapterAuthBindingMatchesMethod,
  type AdapterAuthBinding,
  type AdapterAuthConstant,
  type AdapterProviderAuth,
  type AuthCredentialRef,
  type AuthMethodRef,
  type ResolvedProviderAuth,
} from '@makaio/contracts';
import { AuthenticationError } from '@makaio/core';

/** Stable normalized adapter-auth failure categories. */
export type AdapterAuthErrorReason =
  | 'provider-context-unresolved'
  | 'binding-missing'
  | 'binding-ambiguous'
  | 'client-mismatch'
  | 'credential-resolution-failed'
  | 'credential-missing'
  | 'runtime-bus-missing'
  | 'native-auth-unavailable';

/** Typed, credential-free failure at the normalized adapter-auth boundary. */
export class AdapterAuthError extends AuthenticationError {
  /**
   * Create a normalized adapter-auth failure.
   * @param reason - Stable failure category
   * @param message - Credential-free diagnostic
   */
  public constructor(
    public readonly reason: AdapterAuthErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterAuthError';
  }
}

/** Plaintext values produced by the trusted credential resolver. */
export type ResolvedAuthCredentialValues = Readonly<Record<string, string>>;

/** Resolve normalized credential refs without exposing them outside the trusted consumer. */
export type ResolveAuthCredentialRefs = (
  credentialRefs: Readonly<Record<string, AuthCredentialRef>>,
) => Promise<ResolvedAuthCredentialValues>;

/** Input for binding one normalized provider selection to an adapter declaration. */
export interface BindProviderAuthOptions {
  /** Resolved provider authentication selection containing refs but no plaintext. */
  readonly auth: ResolvedProviderAuth;
  /** Authentication declaration for the selected adapter/provider junction. */
  readonly adapterProviderAuth: AdapterProviderAuth;
  /** Other compatible declarations whose environment sinks must also be scrubbed. */
  readonly compatibleProviderAuths?: readonly AdapterProviderAuth[];
}

/** Immutable refs-only adapter binding emitted before connector-local resolution. */
export interface BoundProviderAuthContext {
  /** Selected normalized provider authentication. */
  readonly auth: ResolvedProviderAuth;
  /** The single adapter delivery binding matching the selected method exactly. */
  readonly binding: AdapterAuthBinding;
  /** Complete adapter-wide environment variables removed before selected delivery. */
  readonly scrubEnvVars: readonly string[];
}

/**
 * Select optional field IDs from an explicit normalized auth selection.
 *
 * Trusted credential resolvers use this policy to omit only selected optional
 * refs whose backing secret is unavailable. Keeping it next to the binding
 * contract guarantees host and container materialization share one rule.
 * @param bound - Exact provider/auth binding selected for one adapter runtime.
 * @returns Field IDs whose unavailable refs may be omitted during resolution.
 */
export function getOptionalAuthCredentialFields(bound: BoundProviderAuthContext): readonly string[] {
  if (bound.auth.mode !== 'explicit') return [];
  return bound.auth.definition.fields.filter((field) => !field.required).map((field) => field.id);
}

/** One immutable connector-owned authentication operation. */
export interface ResolvedConnectorAuthDelivery {
  /** Adapter-specific operation identifier. */
  readonly target: string;
  /** Plaintext fields and constant/null suppressions consumed by the operation. */
  readonly values: Readonly<Record<string, AdapterAuthConstant>>;
}

/** Immutable connector-local authentication snapshot. */
export interface ResolvedAdapterAuth {
  /** Selected plaintext values delivered to a spawned process. */
  readonly processEnv: Readonly<Record<string, string>>;
  /** Selected adapter-specific connector operations. */
  readonly connectorDeliveries: readonly ResolvedConnectorAuthDelivery[];
  /** Native auth is inherited only for inferred methods. */
  readonly configInheritance: 'auth-only' | 'empty';
}

/**
 * Recursively freeze a validated runtime snapshot.
 * @param value - Snapshot fragment to freeze.
 * @returns The same deeply frozen value.
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }

  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue);
    }
    return Object.freeze(value);
  }

  return value;
}

/**
 * Compare owner-qualified authentication method references.
 * @param left - First method reference.
 * @param right - Second method reference.
 * @returns Whether both references name exactly the same owner and method.
 */
function methodRefsEqual(left: AuthMethodRef, right: AuthMethodRef): boolean {
  if (left.owner !== right.owner || left.methodId !== right.methodId) {
    return false;
  }

  return left.owner === 'provider'
    ? right.owner === 'provider' && left.providerDefinitionId === right.providerDefinitionId
    : right.owner === 'client' && left.clientId === right.clientId;
}

/**
 * Find bindings whose owner-qualified method exactly matches a selection.
 * @param auth - Adapter/provider authentication declaration.
 * @param method - Selected normalized authentication method.
 * @returns Every exact binding match in declaration order.
 */
function findMatchingBindings(auth: AdapterProviderAuth, method: AuthMethodRef): AdapterAuthBinding[] {
  return auth.bindings.filter((binding) => methodRefsEqual(binding.method, method));
}

/**
 * Select exactly one binding from a validated declaration.
 * @param auth - Adapter/provider authentication declaration.
 * @param method - Selected normalized authentication method.
 * @returns The unique matching delivery binding.
 */
function selectBinding(auth: AdapterProviderAuth, method: AuthMethodRef): AdapterAuthBinding {
  const matches = findMatchingBindings(auth, method);
  if (matches.length === 0) {
    throw new AdapterAuthError('binding-missing', 'No adapter authentication binding matches the selected method.');
  }
  if (matches.length > 1) {
    throw new AdapterAuthError(
      'binding-ambiguous',
      'Multiple adapter authentication bindings match the selected method.',
    );
  }
  return matches[0];
}

/**
 * Compile the complete adapter-wide environment scrub set.
 * @param auth - Selected normalized authentication context.
 * @param declarations - All adapter/provider authentication declarations in scope.
 * @returns Stable deduplicated environment-variable names.
 */
function compileScrubEnvVars(
  auth: ResolvedProviderAuth,
  declarations: readonly AdapterProviderAuth[],
): readonly string[] {
  const scrubEnvVars = new Set<string>();

  for (const declaration of declarations) {
    for (const variable of declaration.scrubEnvVars) {
      scrubEnvVars.add(variable);
    }
    for (const binding of declaration.bindings) {
      for (const delivery of binding.deliveries) {
        if (delivery.kind !== 'process-env') {
          continue;
        }
        for (const variable of Object.values(delivery.fields)) {
          scrubEnvVars.add(variable);
        }
      }
    }
  }

  if (auth.mode === 'explicit') {
    for (const ref of Object.values(auth.credentialRefs)) {
      if (ref.startsWith('env:')) {
        scrubEnvVars.add(ref.slice('env:'.length));
      }
    }
  }

  return [...scrubEnvVars];
}

/**
 * Bind normalized provider authentication to one exact adapter delivery declaration.
 *
 * The result remains refs-only and can therefore travel through adapter configuration
 * plumbing without exposing plaintext. Every object is cloned by schema parsing and
 * deeply frozen so connector startup observes one stable selection.
 * @param options - Selected auth plus selected and compatible adapter declarations.
 * @returns Immutable refs-only provider auth binding.
 */
export function bindProviderAuth(options: BindProviderAuthOptions): BoundProviderAuthContext {
  const parsedAuth = ResolvedProviderAuthSchema.safeParse(options.auth);
  if (!parsedAuth.success) {
    throw new Error('Resolved provider authentication is invalid.');
  }

  // Check only duplicate exact matches before parsing. A malformed declaration
  // with no match must still report that its declaration is invalid.
  if (findMatchingBindings(options.adapterProviderAuth, parsedAuth.data.method).length > 1) {
    throw new AdapterAuthError(
      'binding-ambiguous',
      'Multiple adapter authentication bindings match the selected method.',
    );
  }

  const parsedSelectedDeclaration = AdapterProviderAuthSchema.safeParse(options.adapterProviderAuth);
  if (!parsedSelectedDeclaration.success) {
    throw new Error('Selected adapter authentication declaration is invalid.');
  }

  const declarations = [parsedSelectedDeclaration.data];
  for (const declaration of options.compatibleProviderAuths ?? []) {
    const parsedDeclaration = AdapterProviderAuthSchema.safeParse(declaration);
    if (!parsedDeclaration.success) {
      throw new Error('Compatible adapter authentication declaration is invalid.');
    }
    declarations.push(parsedDeclaration.data);
  }

  const binding = selectBinding(parsedSelectedDeclaration.data, parsedAuth.data.method);
  assertAdapterAuthBindingMatchesMethod(binding, parsedAuth.data.definition);

  return deepFreeze({
    auth: parsedAuth.data,
    binding,
    scrubEnvVars: compileScrubEnvVars(parsedAuth.data, declarations),
  });
}

/**
 * Resolve a bound provider auth context into one immutable connector-local snapshot.
 *
 * Explicit refs are resolved exactly once. Only required fields must materialize;
 * unavailable optional fields are omitted from every delivery. Inferred and no-auth
 * methods never invoke the credential resolver.
 * @param bound - Immutable refs-only adapter binding.
 * @param resolveCredentialRefs - Trusted local credential resolver.
 * @returns Immutable plaintext delivery snapshot.
 */
export async function resolveBoundProviderAuth(
  bound: BoundProviderAuthContext,
  resolveCredentialRefs: ResolveAuthCredentialRefs,
): Promise<ResolvedAdapterAuth> {
  const values = await resolveSelectedCredentialValues(bound.auth, resolveCredentialRefs);
  const processEnvEntries: Array<readonly [string, string]> = [];
  const connectorDeliveries: ResolvedConnectorAuthDelivery[] = [];

  for (const delivery of bound.binding.deliveries) {
    if (delivery.kind === 'process-env') {
      processEnvEntries.push(...mapResolvedFields(values, delivery.fields));
      continue;
    }
    if (delivery.kind !== 'connector') {
      continue;
    }

    const resolvedFields = Object.fromEntries(mapResolvedFields(values, delivery.fields));
    // Object spread creates own data properties, so even an adapter-declared
    // target named "__proto__" cannot invoke the legacy prototype setter.
    const connectorValues: Record<string, AdapterAuthConstant> = {
      ...delivery.constants,
      ...resolvedFields,
    };
    connectorDeliveries.push({ target: delivery.target, values: connectorValues });
  }

  return deepFreeze({
    processEnv: Object.fromEntries(processEnvEntries),
    connectorDeliveries,
    configInheritance: bound.auth.mode === 'inferred' ? 'auth-only' : 'empty',
  });
}

/**
 * Resolve and validate selected explicit credential values.
 * @param auth - Bound normalized authentication selection.
 * @param resolveCredentialRefs - Trusted local credential resolver.
 * @returns Plaintext values keyed by declared field ID.
 */
async function resolveSelectedCredentialValues(
  auth: ResolvedProviderAuth,
  resolveCredentialRefs: ResolveAuthCredentialRefs,
): Promise<ResolvedAuthCredentialValues> {
  if (auth.mode !== 'explicit') {
    return Object.freeze({});
  }

  let resolved: unknown;
  try {
    resolved = await resolveCredentialRefs(auth.credentialRefs);
  } catch (error) {
    if (error instanceof AdapterAuthError) {
      throw error;
    }
    // Credential refs may contain storage coordinates. Do not preserve a resolver
    // error or cause that could surface those coordinates in startup diagnostics.
    throw new AdapterAuthError('credential-resolution-failed', 'Failed to resolve adapter authentication credentials.');
  }

  if (resolved === null || typeof resolved !== 'object') {
    throw new Error('Credential resolver returned invalid authentication values.');
  }

  let resolvedEntries: Array<readonly [string, unknown]>;
  try {
    resolvedEntries = Object.entries(resolved);
  } catch {
    throw new Error('Credential resolver returned invalid authentication values.');
  }

  const selectedFieldIds = new Set(Object.keys(auth.credentialRefs));
  const resolvedValues = new Map<string, string>();
  for (const [fieldId, value] of resolvedEntries) {
    if (!selectedFieldIds.has(fieldId) || typeof value !== 'string') {
      // The key itself is untrusted resolver output and may contain a credential
      // ref or secret, so the diagnostic deliberately does not interpolate it.
      throw new Error('Credential resolver returned values outside the selected authentication fields.');
    }
    resolvedValues.set(fieldId, value);
  }

  const valueEntries: Array<readonly [string, string]> = [];
  for (const field of auth.definition.fields) {
    const value = resolvedValues.get(field.id);
    if (typeof value === 'string' && value.length > 0) {
      valueEntries.push([field.id, value]);
    } else if (field.required) {
      throw new AdapterAuthError(
        'credential-missing',
        `Required authentication field "${field.id}" could not be resolved.`,
      );
    }
  }
  return Object.freeze(Object.fromEntries(valueEntries));
}

/**
 * Map available resolved fields into delivery target entries.
 * @param values - Plaintext values keyed by auth field ID.
 * @param fields - Auth-field to delivery-target mapping.
 * @returns Own target/value entries safe to construct with `Object.fromEntries`.
 */
function mapResolvedFields(
  values: ResolvedAuthCredentialValues,
  fields: Readonly<Record<string, string>>,
): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const [fieldId, targetName] of Object.entries(fields)) {
    if (!Object.hasOwn(values, fieldId)) {
      continue;
    }
    const value = values[fieldId];
    if (typeof value === 'string') {
      entries.push([targetName, value]);
    }
  }
  return entries;
}

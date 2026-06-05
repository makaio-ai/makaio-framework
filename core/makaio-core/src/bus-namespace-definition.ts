import type {
  FilterablePayloadIntersection,
  SubjectRecordFromSchemaRecord,
  SubjectSchema,
  TransportRoutingDefault,
} from './types/index.js';
import { nestSubjectDefinitions } from './subject-helpers/index.js';
import type { BusSubjects, FlatSubjectDefinitions } from './subject-helpers/index.js';

/**
 * Report passed to the {@link NamespaceRegistrationOptions} `onSchemaViolation` callback
 * when lenient validation detects a schema mismatch.
 *
 * Canonical owner: `@makaio/core`. `@makaio/bus-core` imports this type from core.
 */
export interface SchemaViolationReport {
  /** Fully-qualified subject key (e.g., `"adapter:claude-code.sdk.event"`) */
  subject: string;
  /** Raw payload that failed validation */
  payload: unknown;
  /** Individual Zod issues from the failed parse */
  issues: unknown[];
}

/**
 * Options controlling runtime schema validation for a registered bus namespace.
 *
 * - `strict` (default) — throw `ValidationError` on schema mismatch
 * - `lenient` — invoke `onSchemaViolation` callback, then deliver the event anyway
 * - `skip` — no validation at all (for cross-Zod-version scenarios, e.g., SDK bundles Zod v3)
 *
 * Canonical owner: `@makaio/core`. `@makaio/bus-core` imports this type from core,
 * not the other way around. Single source of truth — no mirroring.
 */
export type NamespaceRegistrationOptions =
  | { busValidationMode?: 'strict' }
  | {
      busValidationMode: 'lenient';
      onSchemaViolation: (report: SchemaViolationReport) => void;
    }
  | { busValidationMode: 'skip' };

/**
 * A declarative bus namespace definition.
 *
 * Created by {@link createBusNamespace}. Carries typed subject tokens for
 * immediate use in bus operations, plus the original schemas for deferred
 * registration at boot time via `MakaioBus.registerNamespace()`.
 *
 * Does not include `scopedBus()` — that method requires a bus instance and
 * is available on the `BusNamespace` object returned by `registerNamespace()`.
 * @typeParam Domain - Namespace domain string (e.g. `'adapter'`, `'session'`)
 * @typeParam Schemas - Schema record mapping subject keys to Zod schemas
 */
export interface BusNamespaceDefinition<
  Domain extends string = string,
  Schemas extends Record<string, SubjectSchema> = Record<string, SubjectSchema>,
> {
  /** Namespace domain string (e.g., `'adapter'`, `'session'`) */
  readonly name: Domain;
  /**
   * Typed subject tokens for bus operations — no registration needed to use
   * these for `bus.on()`, `bus.emit()`, or `bus.request()`.
   */
  readonly subjects: BusSubjects<FlatSubjectDefinitions<Domain, Schemas>, Domain>;
  /** Original Zod schemas — carried for deferred registration */
  readonly schemas: Schemas;
  /** Registration options (validation mode, violation callback) */
  readonly options?: NamespaceRegistrationOptions;
  /**
   * Default transport routing for all subjects in this namespace when the
   * caller does not provide an explicit `transports` option.
   *
   * Subject-level `defaultTransports` (set via `SubjectDefinitionMeta`) takes
   * precedence over this namespace-level default when both are set.
   *
   * - `'all'` (default when omitted) — send to all registered transports.
   * - `'local-only'` — suppress outbound transport fan-out by default. Callers
   *   can still force transport delivery by passing an explicit `transports`
   *   option. Weaker than `localSubject()`: subjects remain reachable remotely.
   */
  readonly defaultTransports?: TransportRoutingDefault;
  /**
   * Phantom field for type inference of filterable payload shape.
   *
   * Never set at runtime. Exists solely so TypeScript can infer the
   * `FilterPayload` type parameter from the schema record without an
   * explicit annotation at every callsite.
   * @internal
   */
  readonly __filterPayload?: FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>;
}

/**
 * Namespace definition shape required for runtime registration.
 *
 * Structurally derived from {@link BusNamespaceDefinition} with the typed
 * subject tree erased to `unknown`. Composition-root catalogs and extension
 * manifests only need the namespace name, schemas, options, and the runtime
 * subject tokens; keeping this structural type separate lets those catalogs
 * contain heterogeneous namespace definitions without widening every subject
 * tree to an unsafe index signature.
 */
export type RegistrableBusNamespaceDefinition = Omit<BusNamespaceDefinition, 'subjects' | '__filterPayload'> & {
  /** Runtime subject token tree created by `createBusNamespace`. */
  readonly subjects: unknown;
};

/**
 * Options for {@link createBusNamespace}.
 *
 * Extends each variant of {@link NamespaceRegistrationOptions} with an optional
 * `defaultTransports` field so callers can pass both validation mode and routing
 * default in a single options object.
 */
export type CreateBusNamespaceOptions = NamespaceRegistrationOptions & {
  /**
   * Default transport routing for every subject in this namespace when the
   * caller does not provide an explicit `transports` option.
   *
   * Subject-level `defaultTransports` (set via `SubjectDefinitionMeta`) takes
   * precedence over this namespace-level default when both are set.
   *
   * - `'all'` (default when omitted) — send to all registered transports.
   * - `'local-only'` — suppress outbound transport fan-out by default.
   */
  defaultTransports?: TransportRoutingDefault;
};

/**
 * Creates a bus namespace definition with typed subject tokens.
 *
 * Pure function — no side-effects, no bus singleton mutation. The returned
 * definition can be used immediately for bus operations (`bus.on()`,
 * `bus.emit()`, etc.) and registered later at boot time via
 * `MakaioBus.registerNamespace(definition)`.
 * @param name - Namespace domain string (e.g., `'adapter'`, `'session'`)
 * @param schemas - Schema record mapping subject keys to Zod schemas
 * @param options - Optional registration and routing options
 * @returns Namespace definition with typed subject tokens and carried schemas
 * @example
 * ```typescript
 * import { createBusNamespace } from '@makaio/core';
 * import { AdapterSchemas } from './schemas.js';
 *
 * export const AdapterNamespace = createBusNamespace('adapter', AdapterSchemas);
 * export const AdapterSubjects = AdapterNamespace.subjects;
 * ```
 */
export function createBusNamespace<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
  name: Domain,
  schemas: Schemas,
  options?: CreateBusNamespaceOptions,
): BusNamespaceDefinition<Domain, Schemas> {
  const defaultTransports = options?.defaultTransports;
  // Strip defaultTransports before forwarding as NamespaceRegistrationOptions —
  // it is a createBusNamespace-level concern, not a namespace-registration one.
  let registrationOptions: NamespaceRegistrationOptions | undefined;
  if (options !== undefined) {
    const { defaultTransports: _ignored, ...rest } = options;
    registrationOptions = Object.keys(rest).length > 0 ? (rest as NamespaceRegistrationOptions) : undefined;
  }
  return {
    name,
    subjects: nestSubjectDefinitions(name, schemas, defaultTransports),
    schemas,
    ...(registrationOptions !== undefined ? { options: registrationOptions } : {}),
    ...(defaultTransports !== undefined ? { defaultTransports } : {}),
  };
}

import { NAMESPACE_ALREADY_OWNED, type NamespaceLease } from '@makaio/contracts/extension';
import { z } from 'zod';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';

import { CHANNEL_NAMESPACE_PREFIX } from '../channel/types.js';
import type { BusNamespace } from '../types/namespace.js';
import { inspectSubjectSchema } from '@makaio/core';
import { isRequestSchema } from '../utils/is-request-schema.js';
import {
  type SubjectRoutingMetadata,
  validateStartupObservation,
  buildNamespaceRoutingMetadataFromInspections,
  failOnRoutingMetadataCollision,
} from './routing-metadata.js';
import {
  assertCompatibleRefinedObjectExtension,
  trackRefinedObjectExtension,
} from './refined-extension-compatibility.js';
import type { ScopedBus } from '../scoped-bus.js';
import type {
  BaseSubjectSchema,
  BusNamespaceDefinition,
  ExtensionName,
  FilterablePayloadIntersection,
  JournalOptions,
  NamespaceRegistrationOptions,
  SchemaViolationReport,
  SubjectDefinition,
  SubjectRecordFromSchemaRecord,
  SubjectSchema,
  SubjectSchemaInspection,
  TransportRoutingDefault,
} from '@makaio/core';

/**
 * Assert that a schema is a ZodObject, throwing a descriptive error if not.
 *
 * Uses `instanceof` intentionally: extendSubject operates on schemas registered
 * via this package's Zod instance. Cross-Zod-version schemas (the busValidationMode: 'skip'
 * scenario) are not candidates for schema extension.
 * @param schema - Schema to check
 * @param label - Human-readable label for the error message
 */
function assertZodObject(schema: unknown, label: string): asserts schema is z.ZodObject<z.ZodRawShape> {
  if (!(schema instanceof z.ZodObject)) {
    const typeName = (schema as { constructor?: { name?: string } })?.constructor?.name ?? typeof schema;
    throw new Error(`[MakaioBus] Cannot extend ${label}: schema is not a ZodObject (got ${typeName})`);
  }
}

/**
 * Extend a Zod object without dropping metadata attached to the original schema.
 *
 * Zod `.safeExtend()` returns a new object schema while preserving refinements.
 * Any policy stored through
 * `.meta()` belongs to the original instance, so the bus must copy it when
 * host packages add fields to a registered subject.
 * @param schema - Original registered object schema.
 * @param extension - Additional fields to merge into the schema.
 * @param label - Human-readable label for error messages.
 * @returns Extended schema carrying the original schema metadata.
 */
function extendZodObject(
  schema: z.ZodObject<z.ZodRawShape>,
  extension: z.ZodRawShape,
  label: string,
): z.ZodObject<z.ZodRawShape> {
  assertCompatibleRefinedObjectExtension(schema, extension, label);
  const extended = schema.safeExtend(extension);
  const metadata = schema.meta();
  const result = metadata ? (extended.meta(metadata) as z.ZodObject<z.ZodRawShape>) : extended;
  trackRefinedObjectExtension(schema, result);
  return result;
}

/**
 * Compare two strings with a stable case-folded primary order and code-point tie-breaker.
 *
 * This intentionally differs from `utils/transport.ts`, which only sorts transport
 * names lexicographically. Registry subject ordering needs the case-folded primary
 * pass so generated protocol manifests and nested definitions stay deterministic.
 * @param left - Left-hand string to compare
 * @param right - Right-hand string to compare
 * @returns Negative when `left` sorts before `right`, positive when after, otherwise zero
 */
function compareStrings(left: string, right: string): number {
  const foldedComparison = compareCodePointStrings(left.toLowerCase(), right.toLowerCase());
  return foldedComparison || compareCodePointStrings(left, right);
}

/**
 * Compare two strings using stable code-point ordering.
 * @param left - Left-hand string to compare
 * @param right - Right-hand string to compare
 * @returns Negative when `left` sorts before `right`, positive when after, otherwise zero
 */
function compareCodePointStrings(left: string, right: string): number {
  if (left === right) return 0;
  let offset = 0;
  for (const char of left) {
    const leftPoint = char.codePointAt(0) ?? 0;
    const rightPoint = right.codePointAt(offset);
    if (rightPoint === undefined) return 1;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    offset += char.length;
  }
  return -1;
}

// Canonical owner: @makaio/core. Re-exported for consumers importing from @makaio/bus-core.
export type { SchemaViolationReport };

/**
 * Callback invoked when a schema violation is detected in lenient mode.
 * @param report - Violation details including subject, payload, and Zod issues
 */
export type SchemaViolationCallback = (report: SchemaViolationReport) => void;

/**
 * Validation mode for a namespace's bus payloads.
 *
 * - `strict` — throw ValidationError on schema mismatch (default)
 * - `lenient` — invoke onSchemaViolation callback, then continue (event still delivered)
 * - `skip` — no validation at all (for Zod version conflicts, e.g., SDK bundles Zod v3)
 */
export type BusValidationMode = 'strict' | 'lenient' | 'skip';

/**
 * Resolved validation config for a namespace's bus payloads.
 */
export interface ValidationConfig {
  /** Active validation mode */
  mode: BusValidationMode;
  /** Callback for lenient-mode violations (undefined for strict/skip) */
  onViolation?: SchemaViolationCallback;
}

/**
 * Runtime schema metadata for one registered bus subject.
 */
export interface RegisteredSubjectSchema {
  /** Namespace passed to `registerNamespace()`. */
  namespace: string;
  /** Subject key inside the namespace's schema record. */
  subject: string;
  /** Fully-qualified subject key in `namespace.subject` form. */
  fullSubject: string;
  /** Unwrapped event or request schema used by runtime validation. */
  schema: BaseSubjectSchema;
  /** Whether the subject was registered through `localSubject()`. */
  local: boolean;
  /** Whether the subject was registered through `collectorOnlySubject()`. */
  collectorOnly: boolean;
  /** Whether the subject was registered through `channelSubject()`. */
  channel: boolean;
  /** Whether the subject was registered through `hostLocalRequest()`. */
  hostLocalRequest: boolean;
  /** Transport policy explicitly declared on this subject. */
  defaultTransports?: TransportRoutingDefault;
  /** Read-only subject of a host namespace accessible during startup. */
  startupObservable?: true;
  /** Journal declaration of a `journalSubject()`-wrapped subject, if any. */
  journal?: JournalOptions;
}

/**
 * Warn if namespace was already registered with different schemas.
 * @param domain - Namespace domain name
 * @param existingSchemas - Schemas from the already-registered namespace.
 * @param newSchemas - Schemas from the new registration attempt.
 */
function warnOnSchemaCollision(
  domain: string,
  existingSchemas: SubjectInspections,
  newSchemas: SubjectInspections,
): void {
  const existingKeys = Array.from(existingSchemas.keys());
  const newKeys = Array.from(newSchemas.keys());
  const added = newKeys.filter((key) => !existingSchemas.has(key));
  const removed = existingKeys.filter((key) => !newSchemas.has(key));
  const changed = newKeys.filter((key) => {
    const existing = existingSchemas.get(key)?.schema;
    const incoming = newSchemas.get(key)?.schema;
    return existing !== undefined && incoming !== undefined && !schemaDefinitionsEqual(existing, incoming);
  });

  if (added.length === 0 && removed.length === 0 && changed.length === 0) return;

  const parts: string[] = [];
  if (added.length > 0) parts.push(`new subjects: ${added.join(', ')}`);
  if (removed.length > 0) parts.push(`missing subjects: ${removed.join(', ')}`);
  if (changed.length > 0) parts.push(`changed schemas: ${changed.join(', ')}`);

  console.warn(
    `[MakaioBus] Namespace '${domain}' already registered with different schemas. ` +
      `${parts.join('; ')}. ` +
      `This usually indicates a namespace collision between packages.`,
  );
}

/**
 * Compare schemas by generated JSON Schema so equivalent duplicate definitions
 * stay idempotent while same-key schema drift still warns.
 * @param existing - Previously registered runtime schema.
 * @param incoming - Newly registered runtime schema.
 * @returns True when the schemas describe the same payload contract.
 */
function schemaDefinitionsEqual(existing: BaseSubjectSchema, incoming: BaseSubjectSchema): boolean {
  return existing === incoming || schemaFingerprint(existing) === schemaFingerprint(incoming);
}

/**
 * Convert a runtime schema to a comparable JSON fingerprint.
 * @param schema - Runtime schema to fingerprint.
 * @returns A stable JSON fingerprint, or the original schema when conversion fails.
 */
function schemaFingerprint(schema: BaseSubjectSchema): string | BaseSubjectSchema {
  try {
    const jsonSchema = isRequestSchema(schema)
      ? { request: z.toJSONSchema(schema.request), response: z.toJSONSchema(schema.response) }
      : z.toJSONSchema(schema);
    return JSON.stringify(jsonSchema);
  } catch {
    return schema;
  }
}

/**
 * Build one schema inspection per subject in a namespace registration.
 *
 * Runs a single {@link inspectSubjectSchema} traversal per subject, reused by
 * both schema-drift comparison and per-subject registration, so each
 * subject's wrapper layers are read exactly once per registration.
 * @param schemas - Raw subject schemas from a namespace definition.
 * @returns Schema inspections keyed by canonical subject key.
 */
function buildNamespaceInspections(schemas: Record<string, SubjectSchema>): SubjectInspections {
  return new Map(Object.entries(schemas).map(([subject, schema]) => [subject, inspectSubjectSchema(schema)]));
}

/**
 * Resolve registration options to runtime validation config.
 * @param options - Namespace registration options
 * @returns Validation config for the namespace
 */
function validationConfigFromOptions(options: NamespaceRegistrationOptions | undefined): ValidationConfig {
  if (options?.busValidationMode === 'lenient') return { mode: 'lenient', onViolation: options.onSchemaViolation };
  if (options?.busValidationMode === 'skip') return { mode: 'skip' };
  return { mode: 'strict' };
}

/**
 * Warn when duplicate namespace registrations disagree on validation policy.
 * @param domain - Namespace domain name
 * @param existing - Previously registered validation config
 * @param incoming - Validation config requested by the duplicate registration
 */
function warnOnValidationConfigCollision(domain: string, existing: ValidationConfig, incoming: ValidationConfig): void {
  if (existing.mode === incoming.mode && existing.onViolation === incoming.onViolation) return;

  console.warn(
    `[MakaioBus] Namespace '${domain}' already registered with different validation settings. ` +
      `Existing mode: ${existing.mode}; incoming mode: ${incoming.mode}. ` +
      `This usually indicates a namespace collision between packages.`,
  );
}

/** Identity responsible for a namespace registration. */
export type NamespaceHolder =
  | { readonly kind: 'host' }
  | { readonly kind: 'extension'; readonly extension: ExtensionName };

/** Holder used for host registrations and reserved namespaces. */
export const HOST_NAMESPACE_HOLDER = Object.freeze({ kind: 'host' } as const);

/** Namespace prefixes reserved for the host, even before registration. */
export const CORE_NAMESPACE_PREFIXES = ['makaio:', CHANNEL_NAMESPACE_PREFIX] as const;

/** Another holder already owns the requested namespace. */
export class NamespaceOwnershipError extends Error {
  public readonly code: typeof NAMESPACE_ALREADY_OWNED = NAMESPACE_ALREADY_OWNED;

  /**
   * Create an error describing a rejected namespace claim.
   * @param namespace - Domain that was claimed.
   * @param owner - Existing holder.
   * @param requester - Holder attempting to claim the domain.
   */
  public constructor(
    public readonly namespace: string,
    public readonly owner: NamespaceHolder,
    public readonly requester: NamespaceHolder,
  ) {
    super(
      `[MakaioBus] Namespace '${namespace}' is already owned by ${holderLabel(owner)}; ` +
        `${holderLabel(requester)} cannot claim it.`,
    );
    this.name = 'NamespaceOwnershipError';
  }
}

/**
 * Format a holder for diagnostics.
 * @param holder - Holder to describe.
 * @returns The host or the extension name.
 */
function holderLabel(holder: NamespaceHolder): string {
  return holder.kind === 'host' ? 'the host' : `extension '${holder.extension}'`;
}

type SubjectInspections = ReadonlyMap<string, SubjectSchemaInspection<BaseSubjectSchema>>;
type LocalityMarks = Pick<SubjectRoutingMetadata, 'local' | 'collectorOnly' | 'hostLocalRequest'>;

type RegisteredNamespace<Namespace = unknown> = {
  namespace: Namespace;
  /** Null marks a permanent host registration. */
  leases: Set<NamespaceLease> | null;
  holder: NamespaceHolder;
  inspections: SubjectInspections;
  routing: ReadonlyMap<string, SubjectRoutingMetadata>;
  validation: ValidationConfig;
  defaultTransports?: 'all' | 'local-only';
};

/** Registered namespace preserving the names and schemas from its definition. */
export type TypedNamespace<Domain extends string, Schemas extends Record<string, SubjectSchema>> = BusNamespace<
  Domain,
  SubjectRecordFromSchemaRecord<Schemas>,
  FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
  Schemas
>;

/** Runtime namespace and subject metadata for one bus context. */
export class NamespaceRegistry {
  /** Observers notified after a new namespace registration becomes visible. */
  public readonly registrationListeners = new Set<() => void>();
  private readonly namespaces = new Map<string, RegisteredNamespace>();
  // Dotted domains and dotted subject keys can produce the same fully qualified key.
  // Keep both registrations so releasing one cannot erase the other's contract.
  private readonly registeredSubjects = new Map<string, RegisteredSubjectSchema[]>();
  // A released domain keeps only transport restrictions until its next claim.
  private readonly releasedLocality = new Map<string, Map<string, LocalityMarks>>();

  /**
   * Register a namespace as the host.
   * @param definition - Namespace definition created by `createBusNamespace()`.
   * @returns The registered namespace with its typed subjects and scoped bus factory.
   */
  public registerNamespace<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
    definition: BusNamespaceDefinition<Domain, Schemas>,
  ): TypedNamespace<Domain, Schemas> {
    const registration = this.register(definition, HOST_NAMESPACE_HOLDER);
    registration.leases = null;
    return registration.namespace;
  }

  /**
   * Claim a namespace for a named holder.
   * @param definition - Namespace definition to register.
   * @param holder - Host or extension claiming the namespace.
   * @returns An independent release handle and the registered namespace.
   */
  public leaseNamespace<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
    definition: BusNamespaceDefinition<Domain, Schemas>,
    holder: NamespaceHolder,
  ): NamespaceLease & { namespace: TypedNamespace<Domain, Schemas> } {
    const registration = this.register(definition, holder);
    const lease = {
      namespace: registration.namespace,
      /** Release this claim once and unregister the last leased claim. */
      release: () => {
        if (registration.leases?.delete(lease) && registration.leases.size === 0) {
          this.release(registration.namespace.name, registration);
        }
      },
    };
    registration.leases?.add(lease);
    return lease;
  }

  /**
   * Register schemas and metadata for a domain after checking its holder and duplicate contracts.
   * @param definition - Namespace definition to register.
   * @param holder - Host or extension claiming the namespace.
   * @returns The registration shared by this domain’s claims.
   */
  private register<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
    definition: BusNamespaceDefinition<Domain, Schemas>,
    holder: NamespaceHolder,
  ): RegisteredNamespace<TypedNamespace<Domain, Schemas>> {
    const { name: domain, schemas, options, defaultTransports } = definition;
    const owner = this.ownerOf(domain);
    if (
      owner &&
      (owner.kind !== holder.kind ||
        (owner.kind === 'extension' && holder.kind === 'extension' && owner.extension !== holder.extension))
    ) {
      throw new NamespaceOwnershipError(domain, owner, holder);
    }

    const inspections = buildNamespaceInspections(schemas);
    validateStartupObservation(domain, holder.kind, inspections, options?.startupObservable);
    const routing = buildNamespaceRoutingMetadataFromInspections(inspections);
    const validation = validationConfigFromOptions(options);
    const existing = this.namespaces.get(domain);
    if (existing) {
      failOnRoutingMetadataCollision(domain, existing.routing, routing);
      warnOnSchemaCollision(domain, existing.inspections, inspections);
      warnOnValidationConfigCollision(domain, existing.validation, validation);
      return existing as RegisteredNamespace<TypedNamespace<Domain, Schemas>>;
    }

    const namespace: TypedNamespace<Domain, Schemas> = {
      name: domain,
      subjects: definition.subjects,
      scopedBus: (bus) =>
        Promise.resolve(
          bus.scoped(namespace) as ScopedBus<
            Domain,
            SubjectRecordFromSchemaRecord<Schemas>,
            FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>
          >,
        ),
    };
    const registration = {
      namespace,
      leases: new Set<NamespaceLease>(),
      holder: Object.freeze({ ...holder }),
      inspections,
      routing,
      validation,
      defaultTransports,
    };
    this.namespaces.set(domain, registration);
    this.releasedLocality.delete(domain);
    for (const [subject, inspection] of inspections) {
      const fullSubject = `${domain}.${subject}`;
      const registrations = this.registeredSubjects.get(fullSubject) ?? [];
      registrations.push({
        namespace: domain,
        subject,
        fullSubject,
        schema: inspection.schema,
        ...inspection.marks,
        ...(options?.startupObservable && { startupObservable: true }),
      });
      this.registeredSubjects.set(fullSubject, registrations);
    }
    this.registrationListeners.forEach((notify) => notify());
    return registration;
  }

  /**
   * Remove the registration after the last lease is released. Keep the locality marks
   * so surviving handlers cannot receive or relay traffic the registration restricted.
   * This discards schema extensions added through {@link extendSubjectSchema} by any caller.
   * A subsequent claim registers the original schemas from its namespace definition.
   * @param domain - Domain to release.
   * @param registration - Record that identifies this lease's registration.
   */
  private release(domain: string, registration: RegisteredNamespace): void {
    if (this.namespaces.get(domain) !== registration) return;
    const locality = new Map<string, LocalityMarks>();
    for (const [subject, { local, collectorOnly, hostLocalRequest }] of registration.routing) {
      if (local || collectorOnly || hostLocalRequest) locality.set(subject, { local, collectorOnly, hostLocalRequest });
      const fullSubject = `${domain}.${subject}`;
      const remaining = this.registeredSubjects.get(fullSubject)?.filter((entry) => entry.namespace !== domain);
      if (remaining?.length) this.registeredSubjects.set(fullSubject, remaining);
      else this.registeredSubjects.delete(fullSubject);
    }
    if (locality.size > 0) this.releasedLocality.set(domain, locality);
    this.namespaces.delete(domain);
  }

  /**
   * Resolve the holder of a namespace, including reservations.
   * @param namespace - Domain to inspect.
   * @returns The current holder or undefined for an unclaimed domain.
   */
  public ownerOf(namespace: string): NamespaceHolder | undefined {
    if (CORE_NAMESPACE_PREFIXES.some((prefix) => namespace.startsWith(prefix))) return HOST_NAMESPACE_HOLDER;
    return this.namespaces.get(namespace)?.holder;
  }

  /**
   * List holders of registered namespaces in namespace order.
   * @returns Registered namespaces and their holders.
   */
  public listOwners(): readonly { namespace: string; owner: NamespaceHolder }[] {
    return Array.from(this.namespaces, ([namespace, { holder: owner }]) => ({ namespace, owner })).sort((left, right) =>
      compareCodePointStrings(left.namespace, right.namespace),
    );
  }

  /**
   * Check whether a namespace is registered.
   * @param name - Domain to look up.
   * @returns True if the domain has a registration.
   */
  public hasNamespace(name: string): boolean {
    return this.namespaces.has(name);
  }

  /**
   * Resolve the domain for a subject, preferring the exact subject record.
   * @param subject - Fully qualified subject.
   * @returns The domain or undefined when the subject has no registered domain.
   */
  public namespaceOf(subject: string): string | undefined {
    return this.registeredSubjects.get(subject)?.at(-1)?.namespace ?? this.findNamespacePrefix(subject);
  }

  /**
   * Search for the longest matching domain ending at a dot boundary.
   * @param subject - String to search.
   * @param matches - Test a candidate domain and its subject key. Defaults to checking registration.
   * @returns The longest matching prefix or undefined.
   */
  private findNamespacePrefix(subject: string, matches?: (domain: string, key: string) => boolean): string | undefined {
    for (let dot = subject.lastIndexOf('.'); dot >= 0; dot = subject.lastIndexOf('.', dot - 1)) {
      const candidate = subject.slice(0, dot);
      const matched = matches?.(candidate, subject.slice(dot + 1)) ?? (dot > 0 && this.hasNamespace(candidate));
      if (matched) return candidate;
      if (dot === 0) break;
    }
    return undefined;
  }

  /**
   * Get the schema for a registered subject.
   * Returns the unwrapped schema: every routing wrapper (`localSubject()`, `channelSubject()`,
   * `collectorOnlySubject()`, `hostLocalRequest()`, `journalSubject()`, `defaultTransports()`)
   * is removed during registration, leaving only the underlying event or request schema.
   * @param subject - Subject identifier (e.g., "adapter.getCapabilities")
   * @returns Schema if found, undefined otherwise
   */
  public getSchema(subject: string | SubjectDefinition): BaseSubjectSchema | undefined {
    const subjectKey = typeof subject === 'string' ? subject : getFullSubjectForSubjectDefinition(subject);
    return this.registeredSubjects.get(subjectKey)?.at(-1)?.schema;
  }
  /**
   * List all registered subjects with their runtime schema metadata.
   * @returns Registered subjects sorted by fully-qualified subject key
   */
  public listRegisteredSubjects(): RegisteredSubjectSchema[] {
    return Array.from(this.registeredSubjects.values())
      .flatMap((registrations) => {
        const subject = registrations.at(-1);
        if (!subject) return [];
        return [{ ...subject, schema: isRequestSchema(subject.schema) ? { ...subject.schema } : subject.schema }];
      })
      .sort((a, b) => compareStrings(a.fullSubject, b.fullSubject));
  }
  /**
   * Get the full registration record for a subject.
   * @param subject - Fully-qualified subject identifier (e.g., "adapter.getCapabilities")
   * @returns A copy of the registration record if found (replacing one of its
   *   fields does not change the registry), undefined otherwise
   */
  public getRegisteredSubject(subject: string): RegisteredSubjectSchema | undefined {
    const entry = this.registeredSubjects.get(subject)?.at(-1);
    return entry === undefined ? undefined : { ...entry };
  }
  /**
   * Check if a subject is registered as a request subject.
   * @param subject - Subject identifier
   * @returns True if subject exists and is a request schema
   */
  public isRequestSubject(subject: string): boolean {
    const schema = this.getSchema(subject);
    return schema !== undefined && isRequestSchema(schema);
  }
  /**
   * Check if a subject was registered as a local-only subject.
   *
   * Local subjects must never be routed over transports. The `__local`
   * routing mark is read from the subject's wrapper layer during
   * registration, including a `localSubject()` wrapped under a `journalSubject()` layer.
   * @param subject - Full subject identifier (e.g., "widget.register")
   * @returns True if the subject was wrapped with `localSubject()`
   */
  public isLocalSubject(subject: string): boolean {
    return this.hasLocalityMark(subject, 'local');
  }
  /**
   * Check if a subject is collector-only.
   *
   * Collector-only events may enter from a transport and run local handlers,
   * but must not be relayed onward to other transports.
   * @param subject - Full subject identifier (e.g., "subject-telemetry.fact")
   * @returns True if the subject was wrapped with `collectorOnlySubject()`
   */
  public isCollectorOnlySubject(subject: string): boolean {
    return this.hasLocalityMark(subject, 'collectorOnly');
  }
  /**
   * Check if a subject was registered as a host-local request subject.
   *
   * Host-local request subjects accept direct remote ingress — a transport
   * may deliver the request to this host — but the receiving bus must never
   * relay the request onward to other transports after ingress.
   * @param subject - Full subject identifier (e.g., "agent.resolveCapability")
   * @returns True if the subject was wrapped with `hostLocalRequest()`
   */
  public isHostLocalRequestSubject(subject: string): boolean {
    return this.hasLocalityMark(subject, 'hostLocalRequest');
  }

  /**
   * Check live registrations and released domains that can declare this exact subject.
   * @param subject - Fully qualified subject.
   * @param mark - Transport restriction to look up.
   * @returns Whether any matching declaration sets the restriction.
   */
  private hasLocalityMark(subject: string, mark: keyof LocalityMarks): boolean {
    if (this.registeredSubjects.get(subject)?.some((entry) => entry[mark])) return true;
    if (this.releasedLocality.size === 0) return false;
    const matches = (domain: string, key: string) => this.releasedLocality.get(domain)?.get(key)?.[mark] === true;
    return this.findNamespacePrefix(subject, matches) !== undefined;
  }
  /**
   * Get the default transport visibility for a subject.
   *
   * Returns the namespace-level `defaultTransports` value recorded at
   * registration time. Subject-level overrides in `SubjectDefinitionMeta`
   * take precedence and are resolved by `emit()` directly from the subject
   * definition token.
   *
   * Returns `'all'` when no namespace-level default was registered.
   * @param subject - Fully-qualified subject identifier (e.g., `"session.list"`)
   * @returns Effective namespace-level default transport visibility
   */
  public getDefaultTransports(subject: string): 'all' | 'local-only' {
    const registrations = this.registeredSubjects.get(subject) ?? [];
    for (let index = registrations.length - 1; index >= 0; index -= 1) {
      const policy = this.namespaces.get(registrations[index].namespace)?.defaultTransports;
      if (policy !== undefined) return policy;
    }
    return 'all';
  }
  /**
   * Get the validation configuration for a subject.
   *
   * Looks up the namespace from the subject's prefix and returns
   * the registered mode and optional violation callback.
   * @param subject - Full subject identifier (e.g., "adapter:claude-code.sdk.event")
   * @returns Validation config, or `{ mode: 'strict' }` if none registered
   */
  public getValidationConfig(subject: string): ValidationConfig {
    const domain = this.hasNamespace(subject) ? subject : this.findNamespacePrefix(subject);
    return (domain === undefined ? undefined : this.namespaces.get(domain)?.validation) ?? { mode: 'strict' };
  }
  /**
   * Extend a registered subject's schema with new fields.
   *
   * For request subjects, extends the request and/or response ZodObject via `.safeExtend()`.
   * For event subjects, extends the event ZodObject via `.safeExtend()`.
   * Successive calls accumulate fields; if a later extension redefines an existing key, the later definition wins.
   * @param fullSubjectKey - Fully-qualified key (e.g., "session.list")
   * @param additionalFields - For request subjects: `{ request?, response? }` each a record
   *   of Zod field definitions. For event subjects: a flat record of Zod field definitions.
   * @throws Error if the subject is not registered or the existing schema is not a ZodObject
   */
  public extendSubjectSchema(
    fullSubjectKey: string,
    additionalFields: z.ZodRawShape | { request?: z.ZodRawShape; response?: z.ZodRawShape },
  ): void {
    const entry = this.registeredSubjects.get(fullSubjectKey)?.at(-1);
    if (!entry) {
      throw new Error(
        `[MakaioBus] Cannot extend subject '${fullSubjectKey}': not registered. ` +
          `Ensure the owning namespace is imported before calling extendSubject().`,
      );
    }

    const current = entry.schema;
    if (isRequestSchema(current)) {
      const ext = additionalFields as { request?: z.ZodRawShape; response?: z.ZodRawShape };
      const { request, response } = current;
      const requestLabel = `'${fullSubjectKey}' request`;
      const responseLabel = `'${fullSubjectKey}' response`;
      if (ext.request) assertZodObject(request, requestLabel);
      if (ext.response) assertZodObject(response, responseLabel);
      entry.schema = {
        request: ext.request ? extendZodObject(request as z.ZodObject, ext.request, requestLabel) : request,
        response: ext.response ? extendZodObject(response as z.ZodObject, ext.response, responseLabel) : response,
      };
    } else {
      assertZodObject(current, `'${fullSubjectKey}'`);
      entry.schema = extendZodObject(current, additionalFields as z.ZodRawShape, `'${fullSubjectKey}'`);
    }
  }
  /**
   * Reset all registered namespaces (for testing only).
   * @internal
   */
  public readonly __resetNamespaces =
    process.env.NODE_ENV === 'test'
      ? () => {
          this.namespaces.clear();
          this.registeredSubjects.clear();
          this.releasedLocality.clear();
        }
      : undefined;
}

/**
 * Create the namespace registry for a bus context.
 * @returns An empty namespace registry.
 */
export function createNamespaceRegistry(): NamespaceRegistry {
  return new NamespaceRegistry();
}

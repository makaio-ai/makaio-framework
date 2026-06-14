import type { MakaioBusContext } from '../types/index.js';
import { z } from 'zod';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';

import type { BusNamespace } from '../types/namespace.js';
import { isChannelSchema } from '../utils/channel-schema.js';
import { isCollectorOnlySchema } from '@makaio/core';
import { isRequestSchema } from '../utils/is-request-schema.js';
import { isLocalSchema } from '../utils/local-schema.js';
import { unwrapSchema } from '../utils/unwrap-schema.js';
import type { ScopedBus } from '../scoped-bus.js';
import type {
  BaseSubjectSchema,
  BusNamespaceDefinition,
  FilterablePayloadIntersection,
  NamespaceRegistrationOptions,
  RegistrableBusNamespaceDefinition,
  SchemaViolationReport,
  SubjectDefinition,
  SubjectRecord,
  SubjectRecordFromSchemaRecord,
  SubjectSchema,
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
 * Unwrap transparent output-preserving schema layers before field compatibility checks.
 * @param schema - Field schema to inspect.
 * @returns Innermost field schema for common transparent wrappers.
 */
function unwrapFieldSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodReadonly
  ) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

/**
 * Extract literal value descriptors from a Zod literal schema.
 * @param schema - Literal schema to inspect.
 * @returns Runtime value descriptors, or undefined when unavailable.
 */
function literalValueDomain(schema: z.ZodLiteral): ReadonlySet<string> | undefined {
  const values = (schema._def as { values?: readonly unknown[] }).values;
  if (!values) return undefined;
  return new Set(values.map((value) => `literal:${typeof value}:${String(value)}`));
}

/**
 * Build a small runtime output-domain model for the Zod field types that can
 * safely participate in refined-object overrides.
 * @param schema - Field schema to inspect.
 * @returns Domain descriptors, or undefined when the field is too complex.
 */
function fieldValueDomain(schema: z.ZodType): ReadonlySet<string> | undefined {
  const domain = new Set<string>();
  if (schema instanceof z.ZodOptional) domain.add('undefined');
  if (schema instanceof z.ZodNullable) domain.add('null');

  const inner = unwrapFieldSchema(schema);
  if (inner instanceof z.ZodLiteral) {
    const literalDomain = literalValueDomain(inner);
    if (!literalDomain) return undefined;
    for (const value of literalDomain) domain.add(value);
    return domain;
  }
  if (inner instanceof z.ZodString) domain.add('string');
  else if (inner instanceof z.ZodNumber) domain.add('number');
  else if (inner instanceof z.ZodBoolean) domain.add('boolean');
  else if (inner instanceof z.ZodBigInt) domain.add('bigint');
  else if (inner instanceof z.ZodDate) domain.add('date');
  else if (inner instanceof z.ZodArray) domain.add('array');
  else if (inner instanceof z.ZodObject) domain.add('object');
  else return undefined;

  return domain;
}

/**
 * Check whether every value accepted by an extension field also satisfies the
 * original field's broad runtime output domain.
 * @param original - Original object field schema.
 * @param extension - Extension field schema replacing the original field.
 * @returns True when the known extension domain is a subset of the original domain.
 */
function extensionFieldIsCompatible(original: z.ZodType, extension: z.ZodType): boolean {
  const originalDomain = fieldValueDomain(original);
  const extensionDomain = fieldValueDomain(extension);
  if (!originalDomain || !extensionDomain) return false;

  for (const value of extensionDomain) {
    if (originalDomain.has(value)) continue;
    const primitive = value.startsWith('literal:') ? value.slice('literal:'.length).split(':', 1)[0] : value;
    if (!originalDomain.has(primitive)) return false;
  }
  return true;
}

/**
 * Detect whether an object schema carries refinements that will run after field parsing.
 * @param schema - Object schema to inspect.
 * @returns True when the object has registered refinement checks.
 */
function hasObjectRefinements(schema: z.ZodObject<z.ZodRawShape>): boolean {
  const checks = (schema._def as { checks?: readonly unknown[] }).checks;
  return Array.isArray(checks) && checks.length > 0;
}

/**
 * Reject refined-object field overrides that can feed incompatible parsed values
 * into existing refinement callbacks.
 * @param schema - Original registered object schema.
 * @param extension - Extension shape to merge.
 * @param label - Human-readable label for error messages.
 */
function assertCompatibleRefinedObjectExtension(
  schema: z.ZodObject<z.ZodRawShape>,
  extension: z.ZodRawShape,
  label: string,
): void {
  if (!hasObjectRefinements(schema)) return;

  const shape = schema.shape;
  for (const [key, extensionField] of Object.entries(extension)) {
    const originalField = shape[key];
    if (!originalField) continue;
    if (extensionFieldIsCompatible(originalField as z.ZodType, extensionField as z.ZodType)) continue;
    throw new Error(
      `[MakaioBus] Cannot extend ${label}: field '${key}' overrides an incompatible refined schema field`,
    );
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
function extendZodObjectPreservingMetadata(
  schema: z.ZodObject<z.ZodRawShape>,
  extension: z.ZodRawShape,
  label: string,
): z.ZodObject<z.ZodRawShape> {
  assertCompatibleRefinedObjectExtension(schema, extension, label);
  const extended = schema.safeExtend(extension);
  const metadata = schema.meta();
  return metadata ? (extended.meta(metadata) as z.ZodObject<z.ZodRawShape>) : extended;
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
  if (foldedComparison !== 0) return foldedComparison;

  return compareCodePointStrings(left, right);
}

/**
 * Compare two strings using stable code-point ordering.
 * @param left - Left-hand string to compare
 * @param right - Right-hand string to compare
 * @returns Negative when `left` sorts before `right`, positive when after, otherwise zero
 */
function compareCodePointStrings(left: string, right: string): number {
  if (left === right) return 0;

  const leftCodePoints = Array.from(left);
  const rightCodePoints = Array.from(right);
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);

  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index].codePointAt(0);
    const rightCodePoint = rightCodePoints[index].codePointAt(0);

    if (leftCodePoint !== rightCodePoint) {
      return (leftCodePoint ?? 0) < (rightCodePoint ?? 0) ? -1 : 1;
    }
  }

  return leftCodePoints.length - rightCodePoints.length;
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
}

const getScopedBus = async <
  Namespace extends string,
  Subjects extends SubjectRecord = SubjectRecord,
  FilterPayload = unknown,
>(
  namespace: Namespace,
  context?: MakaioBusContext,
) => {
  if (!namespace) throw new Error('Namespace not initialized yet');
  const { MakaioBus } = await import('../bus.js');
  const { createScopedBus } = await import('../scoped-bus.js');

  const contextToUse = context ?? MakaioBus.getContext();

  if (!contextToUse)
    throw new Error('No MakaioBus context available. Please provide a context when calling scopedBus().');

  return createScopedBus<Namespace, Subjects, FilterPayload>(contextToUse, namespace);
};

/**
 * Warn if namespace was already registered with different schemas.
 * @param domain - Namespace domain name
 * @param existingSchemas - Schemas from the already-registered namespace.
 * @param newSchemas - Schemas from the new registration attempt.
 */
function warnOnSchemaCollision(
  domain: string,
  existingSchemas: ReadonlyMap<string, BaseSubjectSchema>,
  newSchemas: ReadonlyMap<string, BaseSubjectSchema>,
): void {
  const existingKeys = Array.from(existingSchemas.keys());
  const newKeys = Array.from(newSchemas.keys());
  const added = newKeys.filter((key) => !existingSchemas.has(key));
  const removed = existingKeys.filter((key) => !newSchemas.has(key));
  const changed = newKeys.filter((key) => {
    const existing = existingSchemas.get(key);
    const incoming = newSchemas.get(key);
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
  const existingFingerprint = schemaFingerprint(existing);
  const incomingFingerprint = schemaFingerprint(incoming);
  if (typeof existingFingerprint === 'string' && typeof incomingFingerprint === 'string') {
    return existingFingerprint === incomingFingerprint;
  }
  return existing === incoming;
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
 * Build the comparable runtime schema map for one namespace registration.
 * @param schemas - Raw subject schemas from a namespace definition.
 * @returns Subject schemas keyed by canonical subject key.
 */
function buildNamespaceSubjectSchemas(schemas: Record<string, SubjectSchema>): ReadonlyMap<string, BaseSubjectSchema> {
  const subjectSchemas = new Map<string, BaseSubjectSchema>();
  for (const [subject, schema] of Object.entries(schemas)) {
    subjectSchemas.set(subject, unwrapSchema(schema));
  }
  return subjectSchemas;
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

/**
 * Creates the namespace registry used by a bus context.
 *
 * Maintains a runtime map of registered namespaces and their subject schemas,
 * enabling schema lookup, request-subject detection, local-subject detection,
 * and validation configuration for namespaces that bundle incompatible Zod versions.
 * @returns Namespace registry with registerNamespace, getSchema, listRegisteredSubjects,
 *   isRequestSubject, isLocalSubject, getValidationConfig, and (test-only) __resetNamespaces methods
 */
// eslint-disable-next-line max-lines-per-function -- registry factory holds schema, local, and exempt tracking; splitting would fragment related state
export const createNamespaceRegistry = () => {
  // Internal runtime registry for namespace lookup
  const namespaceRegistry = new Map<string, unknown>();
  // Canonical unwrapped schemas per namespace (for example `channel.open`) so
  // collision warnings compare both subject keys and same-key schema drift.
  const namespaceSubjectSchemas = new Map<string, ReadonlyMap<string, BaseSubjectSchema>>();
  // Internal registry for subject schemas (always unwrapped)
  const subjectSchemas = new Map<string, BaseSubjectSchema>();
  const registeredSubjects = new Map<string, RegisteredSubjectSchema>();
  // Full subject keys registered with subject wrappers. Wrapper flags are
  // stripped by unwrapSchema, so routing metadata is tracked separately.
  const localSubjects = new Set<string>();
  const collectorOnlySubjects = new Set<string>();
  // Validation configuration per namespace domain
  const validationConfig = new Map<string, ValidationConfig>();
  // Default transport visibility per fully-qualified subject key.
  // Populated at registration time from namespace-level defaultTransports.
  const defaultTransportsMap = new Map<string, 'all' | 'local-only'>();

  return {
    /**
     * Register a namespace in the runtime registry.
     *
     * Accepts a {@link BusNamespaceDefinition} created by `createBusNamespace()` from
     * `@makaio/core`. The FilterPayload type parameter is computed eagerly from the
     * schemas, enabling type-safe filtering via `withFilter()`.
     * @param definition - Namespace definition created by `createBusNamespace()`
     * @returns The registered namespace with `scopedBus()` and pre-computed FilterPayload type
     */
    registerNamespace<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
      definition: BusNamespaceDefinition<Domain, Schemas>,
    ): BusNamespace<
      Domain,
      SubjectRecordFromSchemaRecord<Schemas>,
      FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
      Schemas
    > {
      const { name: domain, schemas, options } = definition;
      const incomingSubjectSchemas = buildNamespaceSubjectSchemas(schemas);

      // Type alias for the computed FilterPayload - evaluated at registration time
      type Subjects = SubjectRecordFromSchemaRecord<Schemas>;
      type FilterPayload = FilterablePayloadIntersection<Subjects>;
      type NamespaceType = BusNamespace<Domain, Subjects, FilterPayload, Schemas>;

      // Check if namespace already exists - if so, return it (idempotent)
      const existing = namespaceRegistry.get(domain);
      if (existing) {
        warnOnSchemaCollision(domain, namespaceSubjectSchemas.get(domain) ?? new Map(), incomingSubjectSchemas);
        warnOnValidationConfigCollision(
          domain,
          validationConfig.get(domain) ?? { mode: 'strict' },
          validationConfigFromOptions(options),
        );
        return existing as NamespaceType;
      }

      validationConfig.set(domain, validationConfigFromOptions(options));
      namespaceSubjectSchemas.set(domain, incomingSubjectSchemas);

      for (const [subject, schema] of Object.entries(schemas)) {
        const fullSubjectKey = `${domain}.${subject}`;
        const local = isLocalSchema(schema);
        const collectorOnly = isCollectorOnlySchema(schema);
        const channel = isChannelSchema(schema);
        const unwrappedSchema = incomingSubjectSchemas.get(subject) ?? unwrapSchema(schema);
        // Store unwrapped schema so getSchema/isRequestSubject work correctly
        subjectSchemas.set(fullSubjectKey, unwrappedSchema);
        registeredSubjects.set(fullSubjectKey, {
          namespace: domain,
          subject,
          fullSubject: fullSubjectKey,
          schema: unwrappedSchema,
          local,
          collectorOnly,
          channel,
        });
        // Track locality before unwrapping — isLocalSchema checks __local which
        // is stripped by unwrapSchema.
        if (local) {
          localSubjects.add(fullSubjectKey);
        }
        if (collectorOnly) {
          collectorOnlySubjects.add(fullSubjectKey);
        }
        // Propagate namespace-level defaultTransports to each subject key so
        // emit() can resolve the effective default in O(1).
        if (definition.defaultTransports) {
          defaultTransportsMap.set(fullSubjectKey, definition.defaultTransports);
        }
      }

      const namespace: NamespaceType = {
        name: domain,
        subjects: definition.subjects as NamespaceType['subjects'],
        scopedBus: (context) =>
          getScopedBus<Domain, Subjects, FilterPayload>(domain, context) as Promise<
            ScopedBus<Domain, Subjects, FilterPayload>
          >,
      };

      namespaceRegistry.set(domain, namespace);

      return namespace;
    },

    /**
     * Register multiple namespaces in a single call.
     *
     * Iterates `definitions` and calls `registerNamespace()` for each. Useful
     * at composition roots to register a catalog of namespace definitions in one
     * statement:
     *
     * ```typescript
     * MakaioBus.registerNamespaces(FrameworkContractNamespaces);
     * ```
     * @param definitions - Array of namespace definitions to register
     */
    registerNamespaces(definitions: readonly RegistrableBusNamespaceDefinition[]): void {
      for (const definition of definitions) {
        this.registerNamespace(definition as BusNamespaceDefinition<string, Record<string, SubjectSchema>>);
      }
    },
    /**
     * Get the schema for a registered subject.
     * Returns the unwrapped schema (LocalSubjectSchema and ChannelSubjectSchema wrappers are removed during registration).
     * @param subject - Subject identifier (e.g., "adapter.getCapabilities")
     * @returns Schema if found, undefined otherwise
     */
    getSchema(subject: string | SubjectDefinition): BaseSubjectSchema | undefined {
      const subjectKey = typeof subject === 'string' ? subject : getFullSubjectForSubjectDefinition(subject);
      return subjectSchemas.get(subjectKey);
    },
    /**
     * List all registered subjects with their runtime schema metadata.
     * @returns Registered subjects sorted by fully-qualified subject key
     */
    listRegisteredSubjects(): RegisteredSubjectSchema[] {
      return Array.from(registeredSubjects.values())
        .map((subject) => ({
          ...subject,
          schema: isRequestSchema(subject.schema) ? { ...subject.schema } : subject.schema,
        }))
        .sort((a, b) => compareStrings(a.fullSubject, b.fullSubject));
    },
    /**
     * Get the full registration record for a subject.
     * @param subject - Fully-qualified subject identifier (e.g., "adapter.getCapabilities")
     * @returns Registration record if found, undefined otherwise
     */
    getRegisteredSubject(subject: string): RegisteredSubjectSchema | undefined {
      return registeredSubjects.get(subject);
    },
    /**
     * Check if a subject is registered as a request subject.
     * @param subject - Subject identifier
     * @returns True if subject exists and is a request schema
     */
    isRequestSubject(subject: string): boolean {
      const schema = subjectSchemas.get(subject);
      if (!schema) return false;
      return isRequestSchema(schema);
    },
    /**
     * Check if a subject was registered as a local-only subject.
     *
     * Local subjects must never be routed over transports. The `__local` flag
     * is stripped by `unwrapSchema`, so locality is tracked in a separate set
     * populated at registration time.
     * @param subject - Full subject identifier (e.g., "widget.register")
     * @returns True if the subject was wrapped with `localSubject()`
     */
    isLocalSubject(subject: string): boolean {
      return localSubjects.has(subject);
    },
    /**
     * Check if a subject is collector-only.
     *
     * Collector-only events may enter from a transport and run local handlers,
     * but must not be relayed onward to other transports.
     * @param subject - Full subject identifier (e.g., "subject-telemetry.fact")
     * @returns True if the subject was wrapped with `collectorOnlySubject()`
     */
    isCollectorOnlySubject(subject: string): boolean {
      return collectorOnlySubjects.has(subject);
    },
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
    getDefaultTransports(subject: string): 'all' | 'local-only' {
      return defaultTransportsMap.get(subject) ?? 'all';
    },
    /**
     * Get the validation configuration for a subject.
     *
     * Looks up the namespace from the subject's prefix and returns
     * the registered mode and optional violation callback.
     * @param subject - Full subject identifier (e.g., "adapter:claude-code.sdk.event")
     * @returns Validation config, or `{ mode: 'strict' }` if none registered
     */
    getValidationConfig(subject: string): ValidationConfig {
      let bestMatch: { namespace: string; config: ValidationConfig } | undefined;
      for (const [ns, config] of validationConfig) {
        if (subject === ns || subject.startsWith(ns + '.')) {
          if (!bestMatch || ns.length > bestMatch.namespace.length) {
            bestMatch = { namespace: ns, config };
          }
        }
      }
      return bestMatch?.config ?? { mode: 'strict' };
    },
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
    extendSubjectSchema(
      fullSubjectKey: string,
      additionalFields: z.ZodRawShape | { request?: z.ZodRawShape; response?: z.ZodRawShape },
    ): void {
      const current = subjectSchemas.get(fullSubjectKey);
      if (!current) {
        throw new Error(
          `[MakaioBus] Cannot extend subject '${fullSubjectKey}': not registered. ` +
            `Ensure the owning namespace is imported before calling extendSubject().`,
        );
      }

      if (isRequestSchema(current)) {
        const ext = additionalFields as { request?: z.ZodRawShape; response?: z.ZodRawShape };
        if (ext.request) assertZodObject(current.request, `'${fullSubjectKey}' request`);
        if (ext.response) assertZodObject(current.response, `'${fullSubjectKey}' response`);
        const extended = {
          request: ext.request
            ? extendZodObjectPreservingMetadata(
                current.request as z.ZodObject<z.ZodRawShape>,
                ext.request,
                `'${fullSubjectKey}' request`,
              )
            : current.request,
          response: ext.response
            ? extendZodObjectPreservingMetadata(
                current.response as z.ZodObject<z.ZodRawShape>,
                ext.response,
                `'${fullSubjectKey}' response`,
              )
            : current.response,
        };
        subjectSchemas.set(fullSubjectKey, extended);
        const entry = registeredSubjects.get(fullSubjectKey);
        if (entry) registeredSubjects.set(fullSubjectKey, { ...entry, schema: extended });
      } else {
        assertZodObject(current, `'${fullSubjectKey}'`);
        const extended = extendZodObjectPreservingMetadata(
          current,
          additionalFields as z.ZodRawShape,
          `'${fullSubjectKey}'`,
        );
        subjectSchemas.set(fullSubjectKey, extended);
        const entry = registeredSubjects.get(fullSubjectKey);
        if (entry) registeredSubjects.set(fullSubjectKey, { ...entry, schema: extended });
      }
    },
    /**
     * Reset all registered namespaces (for testing only).
     * @internal
     */
    __resetNamespaces:
      process.env.NODE_ENV === 'test'
        ? () => {
            namespaceRegistry.clear();
            namespaceSubjectSchemas.clear();
            subjectSchemas.clear();
            registeredSubjects.clear();
            localSubjects.clear();
            collectorOnlySubjects.clear();
            validationConfig.clear();
            defaultTransportsMap.clear();
          }
        : undefined,
  };
};

export type NamespaceRegistry = ReturnType<typeof createNamespaceRegistry>;

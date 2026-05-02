import type { MakaioBusContext } from '../types/index.js';
import { z } from 'zod';
import { getFullSubjectForSubjectDefinition, nestSubjectDefinitions } from '../utils/subject-transformation.js';

import type { BusNamespace } from '../types/namespace.js';
import { isChannelSchema } from '../utils/channel-schema.js';
import { isRequestSchema } from '../utils/is-request-schema.js';
import { isLocalSchema } from '../utils/local-schema.js';
import { unwrapSchema } from '../utils/unwrap-schema.js';
import type { ScopedBus } from '../scoped-bus.js';
import type {
  BaseSubjectSchema,
  FilterablePayloadIntersection,
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

/**
 * Report passed to the onSchemaViolation callback when lenient validation detects a schema mismatch.
 */
export interface SchemaViolationReport {
  /** Fully-qualified subject key (e.g., "adapter:claude-code.sdk.event") */
  subject: string;
  /** Raw payload that failed validation */
  payload: unknown;
  /** Individual Zod issues from the failed parse */
  issues: z.ZodIssue[];
}

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
 * Options for namespace registration.
 */
export type NamespaceRegistrationOptions =
  | { busValidationMode?: 'strict' }
  | { busValidationMode: 'lenient'; onSchemaViolation: SchemaViolationCallback }
  | { busValidationMode: 'skip' };

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
 * @param existingKeys - Keys from the already-registered namespace
 * @param newKeys - Keys from the new registration attempt
 */
function warnOnSchemaCollision(domain: string, existingKeys: string[], newKeys: string[]): void {
  const missingKeys = newKeys.filter((k) => !existingKeys.includes(k));
  if (missingKeys.length > 0) {
    console.warn(
      `[MakaioBus] Namespace '${domain}' already registered with different schemas. ` +
        `Missing subjects: ${missingKeys.join(', ')}. ` +
        `This usually indicates a namespace collision between packages.`,
    );
  }
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
  // Canonical flat schema keys per namespace (for example `channel.open`) so
  // collision warnings compare schema shape rather than nested runtime tokens.
  const namespaceSchemaKeys = new Map<string, string[]>();
  // Internal registry for subject schemas (always unwrapped)
  const subjectSchemas = new Map<string, BaseSubjectSchema>();
  const registeredSubjects = new Map<string, RegisteredSubjectSchema>();
  // Full subject keys registered with localSubject() — the __local flag is
  // stripped by unwrapSchema, so we track locality separately.
  const localSubjects = new Set<string>();
  // Validation configuration per namespace domain
  const validationConfig = new Map<string, ValidationConfig>();

  return {
    /**
     * Register a namespace in the runtime registry.
     *
     * The FilterPayload type parameter is computed eagerly from the schemas,
     * enabling type-safe filtering via withFilter().
     * @param domain - Domain string
     * @param schemas - SubjectNamespace object
     * @param options - Registration options (e.g., busValidationMode)
     * @returns The registered namespace with pre-computed FilterPayload type
     */
    registerNamespace<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
      domain: Domain,
      schemas: Schemas,
      options?: NamespaceRegistrationOptions,
    ): BusNamespace<
      Domain,
      SubjectRecordFromSchemaRecord<Schemas>,
      FilterablePayloadIntersection<SubjectRecordFromSchemaRecord<Schemas>>,
      Schemas
    > {
      // Type alias for the computed FilterPayload - evaluated at registration time
      type Subjects = SubjectRecordFromSchemaRecord<Schemas>;
      type FilterPayload = FilterablePayloadIntersection<Subjects>;
      type NamespaceType = BusNamespace<Domain, Subjects, FilterPayload, Schemas>;

      // Check if namespace already exists - if so, return it (idempotent)
      const existing = namespaceRegistry.get(domain);
      if (existing) {
        warnOnSchemaCollision(domain, namespaceSchemaKeys.get(domain) ?? [], Object.keys(schemas));
        warnOnValidationConfigCollision(
          domain,
          validationConfig.get(domain) ?? { mode: 'strict' },
          validationConfigFromOptions(options),
        );
        return existing as NamespaceType;
      }

      validationConfig.set(domain, validationConfigFromOptions(options));

      const nestedTokens = nestSubjectDefinitions(domain, schemas);
      namespaceSchemaKeys.set(domain, Object.keys(schemas));

      for (const [subject, schema] of Object.entries(schemas)) {
        const fullSubjectKey = `${domain}.${subject}`;
        const local = isLocalSchema(schema);
        const channel = isChannelSchema(schema);
        const unwrappedSchema = unwrapSchema(schema);
        // Store unwrapped schema so getSchema/isRequestSubject work correctly
        subjectSchemas.set(fullSubjectKey, unwrappedSchema);
        registeredSubjects.set(fullSubjectKey, {
          namespace: domain,
          subject,
          fullSubject: fullSubjectKey,
          schema: unwrappedSchema,
          local,
          channel,
        });
        // Track locality before unwrapping — isLocalSchema checks __local which
        // is stripped by unwrapSchema.
        if (local) {
          localSubjects.add(fullSubjectKey);
        }
      }

      const namespace: NamespaceType = {
        name: domain,
        subjects: nestedTokens as NamespaceType['subjects'],
        scopedBus: (context) =>
          getScopedBus<Domain, Subjects, FilterPayload>(domain, context) as Promise<
            ScopedBus<Domain, Subjects, FilterPayload>
          >,
      };

      namespaceRegistry.set(domain, namespace);

      return namespace;
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
     * Additively extend a registered subject's schema with new fields.
     *
     * For request subjects, extends the request and/or response ZodObject via `.extend()`.
     * For event subjects, extends the event ZodObject directly.
     * Successive calls accumulate fields; if a later extension redefines an existing key, the later definition wins (Zod `.extend()` semantics).
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
          request: ext.request ? (current.request as z.ZodObject<z.ZodRawShape>).extend(ext.request) : current.request,
          response: ext.response
            ? (current.response as z.ZodObject<z.ZodRawShape>).extend(ext.response)
            : current.response,
        };
        subjectSchemas.set(fullSubjectKey, extended);
        const entry = registeredSubjects.get(fullSubjectKey);
        if (entry) registeredSubjects.set(fullSubjectKey, { ...entry, schema: extended });
      } else {
        assertZodObject(current, `'${fullSubjectKey}'`);
        const extended = current.extend(additionalFields as z.ZodRawShape);
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
            namespaceSchemaKeys.clear();
            subjectSchemas.clear();
            registeredSubjects.clear();
            localSubjects.clear();
            validationConfig.clear();
          }
        : undefined,
  };
};

export type NamespaceRegistry = ReturnType<typeof createNamespaceRegistry>;

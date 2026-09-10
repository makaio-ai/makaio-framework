import {
  compileArtifactDataSchema,
  isArtifactDataPathDeclared,
  readArtifactTitle,
  type ArtifactDataValidator,
  type ArtifactKindRegistration,
  type ArtifactRef,
  type ArtifactRevision,
} from '@makaio/contracts';
import { ToolErrorCodes, toolError, toolSuccess, type ToolExecutionContext, type ToolResult } from '@makaio/tools-core';
import type { ReadArtifactsInput, ReadArtifactsOutput } from './schemas.js';

type ReadFailure = ReadArtifactsOutput['results'][number] & { readonly ok: false };
type ReadSuccess = ReadArtifactsOutput['results'][number] & { readonly ok: true };
const MAX_CONCURRENT_ARTIFACT_READS = 4;

/** Host-owned access boundary for selected Artifact reads. */
export interface ArtifactReadHost {
  /** List effective registrations for a requested Kind. */
  listKinds(kind: string, context: ToolExecutionContext): Promise<readonly ArtifactKindRegistration[]>;
  /** Resolve the host-authorized current revision for one Kind and identity. */
  resolveCurrent(
    ref: { readonly kind: string; readonly id: string },
    context: ToolExecutionContext,
  ): Promise<ArtifactRevision | null>;
  /** Resolve the host-authorized exact immutable revision. */
  resolvePinned(ref: ArtifactRef, context: ToolExecutionContext): Promise<ArtifactRevision | null>;
}

interface FieldProjection {
  readonly data: Record<string, unknown>;
  readonly omittedAbsentFields: string[];
}
interface KindLookup {
  readonly registrations?: readonly ArtifactKindRegistration[];
  readonly error?: string;
}
interface ValidatorLookup {
  readonly validator?: ArtifactDataValidator;
  readonly error?: string;
}

/**
 * Create an item-level failure without failing independent batch reads.
 * @param ref - Requested artifact identity.
 * @param code - Stable failure classification.
 * @param message - Actionable failure explanation.
 * @returns Structured item failure.
 */
function readFailure(ref: ReadArtifactsInput['reads'][number]['ref'], code: string, message: string): ReadFailure {
  return { ok: false, ref, error: { code, message } };
}

/**
 * Find the registration for one kind and its exact schema version.
 * @param kinds - Registrations returned by the host catalog.
 * @param kind - Requested kind identifier.
 * @param schemaVersion - Artifact schema version to match.
 * @returns Matching registration, if present.
 */
function lookupKind(
  kinds: readonly ArtifactKindRegistration[],
  kind: string,
  schemaVersion: number,
): ArtifactKindRegistration | undefined {
  return kinds.find((candidate) => candidate.kind === kind && candidate.schemaVersion === schemaVersion);
}

/**
 * Create a batch-local key for one registered artifact data schema.
 * @param kind - Artifact kind discriminator.
 * @param schemaVersion - Positive artifact schema version.
 * @returns Stable batch-local validator key.
 */
function kindSchemaKey(kind: string, schemaVersion: number): string {
  return `${kind}@${schemaVersion}`;
}

/**
 * Read an own JSON property without following the prototype chain.
 * @param object - JSON object to inspect.
 * @param key - Property name to read.
 * @returns Own property value, if present.
 */
function ownValue(object: Record<string, unknown>, key: string): unknown | undefined {
  return Object.hasOwn(object, key) ? Reflect.get(object, key) : undefined;
}

/**
 * Define an own output property without invoking special prototype setters.
 * @param target - Output object receiving the property.
 * @param key - Property name to define.
 * @param value - JSON value to store.
 */
function defineOwnValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/**
 * Copy declared field paths into a detached, shape-preserving output object.
 * @param data - Full artifact data to select from.
 * @param fields - Data-relative paths selected for output.
 * @returns Selected data and declared optional paths absent from this revision.
 */
function selectFields(data: Record<string, unknown>, fields: readonly string[]): FieldProjection {
  const selected: Record<string, unknown> = {};
  const omittedAbsentFields: string[] = [];

  for (const field of fields) {
    const parts = field.split('.');
    let source: Record<string, unknown> = data;
    let missing = false;
    let terminal: unknown;

    for (const [index, part] of parts.entries()) {
      const value = ownValue(source, part);
      if (value === undefined && !Object.hasOwn(source, part)) {
        missing = true;
        break;
      }
      if (index === parts.length - 1) {
        terminal = value;
        break;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        missing = true;
        break;
      }
      source = value as Record<string, unknown>;
    }

    if (missing) {
      omittedAbsentFields.push(field);
      continue;
    }

    let target = selected;
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1) {
        defineOwnValue(target, part, structuredClone(terminal));
        continue;
      }
      const existingTarget = ownValue(target, part);
      if (existingTarget === undefined && !Object.hasOwn(target, part)) {
        const nested: Record<string, unknown> = {};
        defineOwnValue(target, part, nested);
        target = nested;
      } else if (existingTarget !== null && typeof existingTarget === 'object' && !Array.isArray(existingTarget)) {
        target = existingTarget as Record<string, unknown>;
      } else {
        throw new Error(`Selected field '${field}' conflicts with an earlier selected value.`);
      }
    }
  }

  return { data: selected, omittedAbsentFields };
}

/**
 * List named kind views plus the generic complete-payload view.
 * @param kind - Effective kind registration.
 * @returns Available view names.
 */
function availableViews(kind: ArtifactKindRegistration): string[] {
  return ['full', ...Object.keys(kind.views ?? {})].sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve a request selector to one declared selection strategy.
 * @param selector - Requested artifact selector.
 * @param kind - Effective kind registration.
 * @returns Selection strategy or an item-level validation failure.
 */
function resolveSelection(
  selector: ReadArtifactsInput['reads'][number],
  kind: ArtifactKindRegistration,
):
  | { readonly kind: 'full' }
  | { readonly kind: 'fields'; readonly fields: readonly string[] }
  | { readonly kind: 'view'; readonly view: string; readonly fields: readonly string[] }
  | { readonly kind: 'fallback' }
  | ReadFailure {
  if (selector.fields) {
    for (const field of selector.fields) {
      if (!isArtifactDataPathDeclared(kind.dataSchema, field)) {
        return readFailure(
          selector.ref,
          'FIELD_NOT_DECLARED',
          `Field '${field}' is not declared by artifact kind '${kind.kind}'.`,
        );
      }
    }
    return { kind: 'fields', fields: selector.fields };
  }

  const requestedView = selector.view ?? 'compact';
  if (requestedView === 'full') return { kind: 'full' };
  const fields = kind.views?.[requestedView]?.fields;
  if (fields) return { kind: 'view', view: requestedView, fields };
  if (selector.view === undefined) return { kind: 'fallback' };
  return readFailure(
    selector.ref,
    'VIEW_NOT_FOUND',
    `View '${requestedView}' is not available for artifact kind '${kind.kind}'. Available views: ${availableViews(kind).join(', ')}.`,
  );
}

/**
 * Validate and render one resolved immutable artifact revision.
 * @param selector - Original requested selector.
 * @param kind - Effective kind registration.
 * @param artifact - Resolved artifact revision.
 * @param validator - Batch-local compiled validator for the effective kind.
 * @returns Selected artifact response or item-level schema failure.
 */
function materializeRead(
  selector: ReadArtifactsInput['reads'][number],
  kind: ArtifactKindRegistration,
  artifact: ArtifactRevision,
  validator: ArtifactDataValidator,
): ReadSuccess | ReadFailure {
  if (artifact.schemaVersion !== kind.schemaVersion) {
    return readFailure(
      selector.ref,
      'SCHEMA_VERSION_MISMATCH',
      `Artifact '${artifact.id}' revision '${artifact.revision}' uses schema version ${artifact.schemaVersion}, but '${kind.kind}' is registered at version ${kind.schemaVersion}.`,
    );
  }

  try {
    if (!validator(artifact.data)) {
      return readFailure(
        selector.ref,
        'SCHEMA_MISMATCH',
        `Artifact '${artifact.id}' revision '${artifact.revision}' does not satisfy the registered '${kind.kind}' data schema.`,
      );
    }
  } catch (error) {
    return readFailure(
      selector.ref,
      'SCHEMA_MISMATCH',
      `Artifact '${artifact.id}' revision '${artifact.revision}' could not be validated against '${kind.kind}': ${failureMessage(error)}`,
    );
  }

  let title: string;
  try {
    title = readArtifactTitle(artifact.data, kind.titlePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return readFailure(selector.ref, 'SCHEMA_MISMATCH', message);
  }

  const selection = resolveSelection(selector, kind);
  if ('ok' in selection) return selection;
  if (selection.kind === 'full') {
    return {
      ok: true,
      ref: { refClass: 'artifact', kind: artifact.kind, id: artifact.id, revision: artifact.revision },
      title,
      data: structuredClone(artifact.data),
      selection: { mode: 'full', fields: [], omittedAbsentFields: [] },
    };
  }
  if (selection.kind === 'fallback') {
    return {
      ok: true,
      ref: { refClass: 'artifact', kind: artifact.kind, id: artifact.id, revision: artifact.revision },
      title,
      data: {},
      selection: {
        mode: 'fallback',
        fields: [],
        omittedAbsentFields: [],
        guidance: 'No compact view is declared. Request fields explicitly or request view "full".',
      },
    };
  }

  const projected = selectFields(artifact.data, selection.fields);
  return {
    ok: true,
    ref: { refClass: 'artifact', kind: artifact.kind, id: artifact.id, revision: artifact.revision },
    title,
    data: projected.data,
    selection: {
      mode: selection.kind,
      ...(selection.kind === 'view' ? { view: selection.view } : {}),
      fields: [...selection.fields],
      omittedAbsentFields: projected.omittedAbsentFields,
    },
  };
}

/**
 * Resolve either a host-authorized current or exact pinned revision.
 * @param host - Host-owned read boundary.
 * @param context - Tool execution context forwarded to the host.
 * @param selector - Requested artifact selector.
 * @returns Resolved revision, or null when absent.
 */
async function resolveArtifact(
  host: ArtifactReadHost,
  context: ToolExecutionContext,
  selector: ReadArtifactsInput['reads'][number],
): Promise<ArtifactRevision | null> {
  const requestedRevision = selector.ref.revision;
  if (requestedRevision) {
    const ref = {
      refClass: 'artifact' as const,
      kind: selector.ref.kind,
      id: selector.ref.id,
      revision: requestedRevision,
    };
    const artifact = await host.resolvePinned(ref, context);
    if (
      artifact &&
      (artifact.kind !== selector.ref.kind ||
        artifact.id !== selector.ref.id ||
        artifact.revision !== requestedRevision)
    ) {
      throw new Error(
        `Pinned artifact lookup for '${selector.ref.kind}:${selector.ref.id}@${requestedRevision}' returned a different revision.`,
      );
    }
    return artifact;
  }
  return host.resolveCurrent({ kind: selector.ref.kind, id: selector.ref.id }, context);
}

/**
 * Convert an unknown thrown value to a concise error message.
 * @param error - Thrown value.
 * @returns Human-readable message.
 */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read one requested artifact while retaining sibling outcomes after failure.
 * @param selector - Requested artifact selector.
 * @param registrations - Catalog registrations for this Kind, if lookup succeeded.
 * @param kindLookupError - Catalog failure associated with this kind, if any.
 * @param validators - Batch-local validators keyed by Kind and schema version.
 * @param host - Host-owned read boundary.
 * @param context - Tool execution context forwarded to the host.
 * @returns One ordered item-level result.
 */
async function readOne(
  selector: ReadArtifactsInput['reads'][number],
  registrations: readonly ArtifactKindRegistration[] | undefined,
  kindLookupError: string | undefined,
  validators: ReadonlyMap<string, ValidatorLookup>,
  host: ArtifactReadHost,
  context: ToolExecutionContext,
): Promise<ReadSuccess | ReadFailure> {
  if (kindLookupError) return readFailure(selector.ref, 'KIND_LOOKUP_FAILED', kindLookupError);
  if (!registrations || registrations.length === 0)
    return readFailure(selector.ref, 'KIND_NOT_FOUND', `Artifact kind '${selector.ref.kind}' is not registered.`);
  let artifact: ArtifactRevision | null;
  try {
    artifact = await resolveArtifact(host, context, selector);
  } catch (error) {
    return readFailure(selector.ref, 'ARTIFACT_LOOKUP_FAILED', `Artifact lookup failed: ${failureMessage(error)}`);
  }
  if (!artifact)
    return readFailure(
      selector.ref,
      'ARTIFACT_NOT_FOUND',
      `Artifact '${selector.ref.kind}:${selector.ref.id}' was not found.`,
    );
  if (artifact.kind !== selector.ref.kind || artifact.id !== selector.ref.id) {
    return readFailure(selector.ref, 'ARTIFACT_MISMATCH', 'Artifact lookup returned a different artifact identity.');
  }
  const kind = lookupKind(registrations, artifact.kind, artifact.schemaVersion);
  if (!kind) {
    return readFailure(
      selector.ref,
      'SCHEMA_VERSION_MISMATCH',
      `Artifact '${artifact.id}' revision '${artifact.revision}' uses schema version ${artifact.schemaVersion}, but no matching '${artifact.kind}' registration is available.`,
    );
  }
  const validatorLookup = validators.get(kindSchemaKey(kind.kind, kind.schemaVersion));
  if (validatorLookup?.error) {
    return readFailure(
      selector.ref,
      'SCHEMA_MISMATCH',
      `Artifact kind '${kind.kind}' could not compile its data schema: ${validatorLookup.error}`,
    );
  }
  if (!validatorLookup?.validator) {
    return readFailure(selector.ref, 'SCHEMA_MISMATCH', `Artifact kind '${kind.kind}' has no compiled data schema.`);
  }
  try {
    return materializeRead(selector, kind, artifact, validatorLookup.validator);
  } catch (error) {
    return readFailure(selector.ref, 'ARTIFACT_READ_FAILED', `Artifact read failed: ${failureMessage(error)}`);
  }
}

/**
 * Resolve independent host requests with bounded activity while retaining input order.
 * @param values - Ordered values to resolve.
 * @param limit - Maximum active resolutions.
 * @param resolve - Independent value resolver.
 * @returns Ordered resolved values.
 */
async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  limit: number,
  resolve: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await resolve(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

/**
 * Resolve selected artifact content through an explicit host-owned access boundary.
 * @param input - Validated selected-read request.
 * @param context - Tool execution context supplied by the host.
 * @param host - Optional authorized host boundary.
 * @returns Successful ordered item outcomes or a whole-tool infrastructure error.
 */
export async function executeReadArtifacts(
  input: ReadArtifactsInput,
  context: ToolExecutionContext,
  host?: ArtifactReadHost,
): Promise<ToolResult<ReadArtifactsOutput>> {
  if (!host) {
    return toolError(ToolErrorCodes.PERMISSION_DENIED, 'Artifact reads require an authorized host.');
  }

  const registrations = await mapWithConcurrency(
    [...new Set(input.reads.map((read) => read.ref.kind))],
    MAX_CONCURRENT_ARTIFACT_READS,
    async (kind): Promise<readonly [string, KindLookup]> => {
      try {
        const registrations = await host.listKinds(kind, context);
        return [kind, { registrations: registrations.filter((candidate) => candidate.kind === kind) }];
      } catch (error) {
        return [kind, { error: `Artifact kind lookup failed: ${failureMessage(error)}` }];
      }
    },
  );
  const kinds = new Map<string, KindLookup>(registrations);
  const validators = new Map<string, ValidatorLookup>();
  for (const lookup of kinds.values()) {
    for (const registration of lookup.registrations ?? []) {
      const key = kindSchemaKey(registration.kind, registration.schemaVersion);
      if (validators.has(key)) continue;
      try {
        validators.set(key, { validator: compileArtifactDataSchema(registration) });
      } catch (error) {
        validators.set(key, { error: failureMessage(error) });
      }
    }
  }
  const results = await mapWithConcurrency(input.reads, MAX_CONCURRENT_ARTIFACT_READS, async (selector) => {
    const result = kinds.get(selector.ref.kind);
    return readOne(selector, result?.registrations, result?.error, validators, host, context);
  });
  return toolSuccess({ results });
}

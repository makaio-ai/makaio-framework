import type {
  EventSchema,
  JournalOptions,
  RequestSchema,
  SubjectSchema,
  TransportRoutingDefault,
} from '../types/index.js';
import { snapshotJournalOptions } from './journal-subject-schema.js';

/**
 * Routing and journal marks collected while walking a (possibly wrapped) subject
 * schema down to its innermost layer.
 *
 * Every boolean mark defaults to `false` when its wrapper is absent from the walk.
 * `defaultTransports` and `journal` are present only when the corresponding
 * wrapper was found.
 */
export type SubjectMarks = {
  /** True when a `localSubject()` wrapper was found. */
  readonly local: boolean;
  /** True when a `channelSubject()` wrapper was found. */
  readonly channel: boolean;
  /** True when a `collectorOnlySubject()` wrapper was found. */
  readonly collectorOnly: boolean;
  /** True when a `hostLocalRequest()` wrapper was found. */
  readonly hostLocalRequest: boolean;
  /** Default transport routing policy, present only when a `defaultTransports()` wrapper was found. */
  readonly defaultTransports?: TransportRoutingDefault;
  /** Journal options as a frozen copy, present only when a `journalSubject()` wrapper was found. */
  readonly journal?: JournalOptions;
};

/**
 * Result of a traversal: the innermost schema, kept by identity, and every mark
 * collected from the layers walked to reach it.
 * @typeParam T - The innermost schema type
 */
export type SubjectSchemaInspection<T> = {
  /** The innermost schema, returned by identity (no copy). */
  readonly schema: T;
  /** All marks collected across every layer walked. */
  readonly marks: SubjectMarks;
};

/**
 * One wrapper layer read from a candidate: its inner schema and the partial marks
 * it contributes. `undefined` signals that the candidate is not a recognized
 * wrapper, which stops the walk.
 * @typeParam T - The candidate schema type
 */
export type SubjectSchemaLayer<T> = {
  /** The schema found inside this layer. */
  readonly schema: T;
  /** The marks this layer contributes, merged into the running result. */
  readonly marks: Partial<SubjectMarks>;
};

/**
 * Marks with every boolean field `false` and every optional field absent, the
 * starting point of a traversal before any layer has been merged in. Frozen and
 * never returned itself: every inspection returns its own marks object.
 */
const BASE_MARKS: SubjectMarks = Object.freeze({
  local: false,
  channel: false,
  collectorOnly: false,
  hostLocalRequest: false,
});

/**
 * Reads one wrapper layer off a runtime subject schema.
 *
 * Recognizes the journal wrapper and the five routing wrappers by their brand
 * property: the brand must be `=== true` (or, for `__defaultTransports`, carry
 * one of its two routing values), alongside a `schema` property. Every brand
 * present on the layer counts, so an object that carries several brands at
 * once reports all of them.
 * @param candidate - The schema to inspect for one wrapper layer
 * @returns The inner schema and the marks contributed by this layer, or
 *   `undefined` if `candidate` carries no recognized brand
 */
function readSubjectSchemaLayer(candidate: SubjectSchema): SubjectSchemaLayer<SubjectSchema> | undefined {
  if (typeof candidate !== 'object' || candidate === null || !('schema' in candidate)) {
    return undefined;
  }
  const marks: { -readonly [K in keyof SubjectMarks]?: SubjectMarks[K] } = {};
  if ('__journal' in candidate && candidate.__journal === true) {
    const options = candidate.options;
    // A frozen copy, so neither the caller's options nor a hand-built wrapper
    // can change the declaration after it was read.
    marks.journal = snapshotJournalOptions<JournalOptions>(
      typeof options === 'object' && options !== null ? options : {},
    );
  }
  if ('__local' in candidate && candidate.__local === true) marks.local = true;
  if ('__channel' in candidate && candidate.__channel === true) marks.channel = true;
  if ('__collectorOnly' in candidate && candidate.__collectorOnly === true) marks.collectorOnly = true;
  if ('__hostLocalRequest' in candidate && candidate.__hostLocalRequest === true) marks.hostLocalRequest = true;
  if (
    '__defaultTransports' in candidate &&
    (candidate.__defaultTransports === 'all' || candidate.__defaultTransports === 'local-only')
  ) {
    marks.defaultTransports = candidate.__defaultTransports;
  }
  return Object.keys(marks).length === 0 ? undefined : { schema: candidate.schema, marks };
}

/**
 * Walks a runtime subject schema down to its innermost layer, reading marks on
 * the outermost layer and, if (and only if) that layer is a journal wrapper,
 * on exactly one layer beneath it.
 *
 * The journal wrapper is the only layer this traversal looks through: unwrapping
 * removes the journal layer (if present) and then at most one routing layer,
 * which is exactly the single-layer behaviour of a non-journal input. A
 * non-journal outer layer is never peeled further, so arbitrary nested data
 * carried as an inner `schema` (for example an object that itself happens to
 * carry a `__channel` brand) is never mistaken for a routing layer.
 * @param schema - The (possibly wrapped) subject schema to walk
 * @returns The innermost schema and the marks collected from at most two layers
 */
export function inspectSubjectSchema(schema: SubjectSchema): SubjectSchemaInspection<EventSchema | RequestSchema>;
/**
 * Walks a schema of any representation down to its innermost layer using a
 * caller-supplied reader, applying the same at-most-two-layers rule.
 *
 * This generic overload lets a compiler-API adapter (walking `ts.Type` instead of
 * a runtime value) reuse the same traversal.
 * @typeParam T - The schema representation being walked
 * @param schema - The (possibly wrapped) schema to walk
 * @param readLayer - Reads one wrapper layer off a candidate, or returns
 *   `undefined` to stop the walk
 * @returns The innermost schema and the marks collected from at most two layers
 */
export function inspectSubjectSchema<T>(
  schema: T,
  readLayer: (candidate: T) => SubjectSchemaLayer<T> | undefined,
): SubjectSchemaInspection<T>;
export function inspectSubjectSchema<T>(
  schema: T,
  readLayer?: (candidate: T) => SubjectSchemaLayer<T> | undefined,
): SubjectSchemaInspection<T> {
  const read = readLayer ?? (readSubjectSchemaLayer as (candidate: T) => SubjectSchemaLayer<T> | undefined);

  const outer = read(schema);
  if (outer === undefined) {
    return { schema, marks: { ...BASE_MARKS } };
  }

  let marks: SubjectMarks = { ...BASE_MARKS, ...outer.marks };
  let current = outer.schema;

  if (outer.marks.journal !== undefined) {
    const inner = read(current);
    if (inner !== undefined) {
      marks = { ...marks, ...inner.marks };
      current = inner.schema;
    }
  }

  return { schema: current, marks };
}

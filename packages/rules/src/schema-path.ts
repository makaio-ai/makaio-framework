import { isJsonObject, type JsonSchema, type JsonValueType, jsonValueType, ownValue } from '@makaio/contracts/shared';

/*
 * Two walkers read a dot path, and they are not interchangeable: `readDotPath` of
 * `@makaio/contracts` walks a runtime value (`items.0.name` indexes an array), whereas
 * `resolveSchemaPath` below walks a JSON Schema, where the same path goes through
 * `properties`, `items`, `$ref` and combinators and tracks whether each step is required.
 */

/**
 * Where a dot-notation field path leads inside a JSON Schema.
 *
 * - `known`: the schema describes the value at the path. `optionalSteps` holds the index of
 *   every step (into the segments, outermost first) that is not required; it is empty when
 *   every step of the path is required.
 * - `open`: the schema admits the path without describing it; any deeper path is admitted
 *   too. The value has no known type. `optionalSteps` holds the known optional steps before
 *   the open step, the open step itself unless the schema lists it in `required`, and every
 *   deeper step: an undescribed step counts as optional.
 * - `unknown`: the schema does not admit the path.
 */
export type SchemaPathResolution =
  | { kind: 'known'; schema: JsonSchema; optionalSteps: readonly number[] }
  | { kind: 'open'; optionalSteps: readonly number[] }
  | { kind: 'unknown' };

/**
 * JSON value types a schema admits. `integer` is folded into `number`.
 */
export type SchemaValueType = JsonValueType;

/**
 * What a schema says about the type of its value.
 */
export interface SchemaValueDescription {
  /** Types the value may have; `undefined` when the schema does not restrict the type. */
  types: ReadonlySet<SchemaValueType> | undefined;
  /** Whether a string value is constrained to `format: date-time`. */
  dateTime: boolean;
}

/**
 * Result of one path step against one schema node.
 *
 * `closed` means the object forbids unlisted properties (`additionalProperties: false`);
 * `unlisted` means it lists properties but not this one and says nothing about others;
 * `impossible` means the value cannot be an object at all. `closed` and `unlisted` give way
 * to a sibling `allOf` branch that lists the property, which is how `allOf` branches are
 * merged.
 */
type Step =
  | { kind: 'known'; schema: JsonSchema; required: boolean }
  | { kind: 'open'; required: boolean }
  | { kind: 'unlisted'; required: boolean }
  | { kind: 'closed' }
  | { kind: 'impossible' };

/** Keywords this module does not interpret that can admit a property not listed in `properties`. */
const ADMITTING_KEYWORDS = [
  'patternProperties',
  'unevaluatedProperties',
  'dependentSchemas',
  'dependencies',
  'if',
  'then',
  'else',
] as const;

/** A path segment that selects an array element. */
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * Follow a field path through a JSON Schema.
 *
 * Supported keywords: `type` (string or array), `properties`, `required`,
 * `additionalProperties`, `items` (a segment such as `0` selects an array element, which is
 * always optional), `enum`, `const`, `anyOf`/`oneOf` (the path is known if any
 * branch knows it; it is optional unless every branch requires it), `allOf` (branches are
 * merged) and local `$ref` (`#`, `#/$defs/...`, `#/definitions/...`; reference cycles are
 * cut). A schema without `properties` and without `additionalProperties: false`, a schema
 * with an unsupported keyword that could admit the path, and `{}` are open.
 *
 * A schema that lists `properties` without `additionalProperties` does not admit unlisted
 * properties here, so a misspelled field is reported.
 * @param schema - Root schema; local references resolve against it
 * @param segments - Property names of the path, outermost first
 * @returns Where the path leads, with the indexes of the optional steps
 */
export function resolveSchemaPath(schema: JsonSchema, segments: readonly string[]): SchemaPathResolution {
  let current = schema;
  const optionalSteps: number[] = [];

  for (const [index, segment] of segments.entries()) {
    const step = stepInto(current, segment, schema, new Set());
    if (step.kind === 'open') {
      // The open step is optional unless the schema requires it; whatever lies below is undescribed.
      for (let deeper = step.required ? index + 1 : index; deeper < segments.length; deeper += 1) {
        optionalSteps.push(deeper);
      }
      return { kind: 'open', optionalSteps };
    }
    if (step.kind !== 'known') return { kind: 'unknown' };
    current = step.schema;
    if (!step.required) optionalSteps.push(index);
  }

  return { kind: 'known', schema: current, optionalSteps };
}

/**
 * Describe the value type a schema admits, following `$ref`, `allOf`, `anyOf` and `oneOf`.
 * @param schema - Schema of the value, as returned by {@link resolveSchemaPath}
 * @param root - Root schema that local references resolve against
 * @returns The admitted types and whether strings must be date-times
 */
export function describeSchemaValue(schema: JsonSchema, root: JsonSchema): SchemaValueDescription {
  return describe(schema, root, new Set());
}

/**
 * Recognize a schema object. Booleans and other JSON values are not schema objects here.
 * Narrows to {@link JsonSchema}, which `isJsonObject` alone does not.
 * @param value - Value read from a JSON Schema document
 * @returns Whether the value is a schema object
 */
function isSchemaObject(value: unknown): value is JsonSchema {
  return isJsonObject(value);
}

/**
 * Resolve a local JSON pointer reference against the root schema.
 * @param ref - Reference string, for example `#/$defs/Order`
 * @param root - Root schema
 * @returns The referenced schema value, or `undefined` when it is not a resolvable local reference
 */
function resolveRef(ref: string, root: JsonSchema): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;

  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isJsonObject(current)) return undefined;
    current = ownValue(current, key);
  }
  return current;
}

/**
 * Read the schema branches of a combinator keyword.
 * @param node - Schema object
 * @param keyword - `allOf`, `anyOf` or `oneOf`
 * @returns The branches, empty when the keyword is absent or malformed
 */
function branchesOf(node: JsonSchema, keyword: 'allOf' | 'anyOf' | 'oneOf'): unknown[] {
  const value = ownValue(node, keyword);
  return Array.isArray(value) ? value : [];
}

/**
 * Normalize a property subschema to a schema object. `true` and non-object values become
 * the empty schema; `false` yields `undefined` (the property cannot exist).
 * @param value - Subschema value
 * @returns Schema object, or `undefined` for `false`
 */
function toSchemaObject(value: unknown): JsonSchema | undefined {
  if (value === false) return undefined;
  return isSchemaObject(value) ? value : {};
}

/**
 * Take one path step into a schema value.
 * @param value - Schema value (object or boolean)
 * @param key - Property name to step into
 * @param root - Root schema for `$ref`
 * @param refs - References followed during this step, to cut cycles
 * @returns The step result
 */
function stepInto(value: unknown, key: string, root: JsonSchema, refs: ReadonlySet<string>): Step {
  if (value === false) return { kind: 'impossible' };
  if (!isSchemaObject(value)) return { kind: 'open', required: false };

  const parts: Step[] = [ownStep(value, key)];

  const ref = ownValue(value, '$ref');
  if (typeof ref === 'string') {
    const target = refs.has(ref) ? undefined : resolveRef(ref, root);
    parts.push(
      target === undefined ? { kind: 'open', required: false } : stepInto(target, key, root, new Set([...refs, ref])),
    );
  }
  for (const branch of branchesOf(value, 'allOf')) {
    parts.push(stepInto(branch, key, root, refs));
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = branchesOf(value, keyword);
    if (branches.length > 0) {
      parts.push(anyStep(branches.map((branch) => stepInto(branch, key, root, refs))));
    }
  }

  return allStep(parts);
}

/**
 * Take one path step using only the keywords of the node itself, ignoring `$ref` and
 * combinators.
 * @param node - Schema object
 * @param key - Property name to step into
 * @returns The step result
 */
function ownStep(node: JsonSchema, key: string): Step {
  const types = ownTypes(node);
  const admitsObject = types === undefined || types.has('object');
  const admitsIndex = (types === undefined || types.has('array')) && ARRAY_INDEX.test(key);

  const listed = admitsObject ? listedPropertyStep(node, key) : undefined;
  if (listed !== undefined) return listed;
  if (admitsIndex && (types !== undefined || Object.hasOwn(node, 'items'))) return elementStep(node);
  return admitsObject ? unlistedPropertyStep(node, key) : { kind: 'impossible' };
}

/**
 * Whether the node's `required` list names the key.
 * @param node - Schema object
 * @param key - Property name
 * @returns Whether the property is required
 */
function isRequired(node: JsonSchema, key: string): boolean {
  const required = ownValue(node, 'required');
  return Array.isArray(required) && required.includes(key);
}

/**
 * Step into a property listed in `properties`.
 * @param node - Schema object that admits an object value
 * @param key - Property name
 * @returns The step result, or `undefined` when `properties` does not list the key
 */
function listedPropertyStep(node: JsonSchema, key: string): Step | undefined {
  const properties = ownValue(node, 'properties');
  if (!isJsonObject(properties) || !Object.hasOwn(properties, key)) return undefined;
  const schema = toSchemaObject(ownValue(properties, key));
  return schema === undefined ? { kind: 'closed' } : { kind: 'known', schema, required: isRequired(node, key) };
}

/**
 * Step into an array element. An element may be missing (index out of range), so it is
 * never required. A node with its own `prefixItems` is `open`.
 * @param node - Schema object that admits an array value
 * @returns The step result
 */
function elementStep(node: JsonSchema): Step {
  // 2020-12 tuples are not interpreted: `items` then describes only the elements after the
  // prefix, so no index is known to resolve to it.
  if (Object.hasOwn(node, 'prefixItems')) return { kind: 'open', required: false };
  const items = ownValue(node, 'items');
  if (items === false) return { kind: 'closed' };
  if (isSchemaObject(items)) return { kind: 'known', schema: items, required: false };
  return { kind: 'open', required: false };
}

/**
 * Step into a property that `properties` does not list.
 * @param node - Schema object that admits an object value
 * @param key - Property name
 * @returns The step result
 */
function unlistedPropertyStep(node: JsonSchema, key: string): Step {
  const required = isRequired(node, key);
  if (ADMITTING_KEYWORDS.some((keyword) => Object.hasOwn(node, keyword))) {
    return { kind: 'open', required };
  }

  const additional = ownValue(node, 'additionalProperties');
  if (additional === false) return { kind: 'closed' };
  if (isSchemaObject(additional)) return { kind: 'known', schema: additional, required };
  if (additional === true || !isJsonObject(ownValue(node, 'properties'))) return { kind: 'open', required };
  return { kind: 'unlisted', required };
}

/**
 * Combine step results of schemas that all apply (the node, its `$ref` and `allOf`
 * branches, its `anyOf`/`oneOf` groups).
 * @param parts - Step results
 * @returns The merged step result
 */
function allStep(parts: readonly Step[]): Step {
  if (parts.some((part) => part.kind === 'impossible')) return { kind: 'impossible' };

  const required = parts.some((part) => 'required' in part && part.required);
  const known = parts.flatMap((part) => (part.kind === 'known' ? [part.schema] : []));
  if (known.length > 0) return { kind: 'known', schema: combine('allOf', known), required };
  if (parts.some((part) => part.kind === 'closed')) return { kind: 'closed' };
  if (parts.some((part) => part.kind === 'unlisted')) return { kind: 'unlisted', required };
  return { kind: 'open', required };
}

/**
 * Combine step results of alternative schemas (`anyOf`/`oneOf` branches).
 * @param branches - Step results, at least one
 * @returns The combined step result
 */
function anyStep(branches: readonly Step[]): Step {
  if (branches.some((branch) => branch.kind === 'open')) {
    // Required only when every branch requires the key; a closed or impossible branch does not.
    return { kind: 'open', required: branches.every((branch) => 'required' in branch && branch.required) };
  }

  const known = branches.flatMap((branch) => (branch.kind === 'known' ? [branch.schema] : []));
  if (known.length > 0) {
    const required = branches.every((branch) => branch.kind === 'known' && branch.required);
    return { kind: 'known', schema: combine('anyOf', known), required };
  }
  if (branches.some((branch) => branch.kind === 'unlisted')) return { kind: 'unlisted', required: false };
  if (branches.some((branch) => branch.kind === 'closed')) return { kind: 'closed' };
  return { kind: 'impossible' };
}

/**
 * Join schemas under a combinator, or return the single schema unchanged.
 * @param keyword - `allOf` or `anyOf`
 * @param schemas - Schemas to join, at least one
 * @returns The joined schema
 */
function combine(keyword: 'allOf' | 'anyOf', schemas: readonly JsonSchema[]): JsonSchema {
  const [first] = schemas;
  return schemas.length === 1 && first !== undefined ? first : { [keyword]: [...schemas] };
}

/**
 * Map a JSON Schema type name to a value type.
 * @param name - Entry of `type`
 * @returns The value type, or `undefined` for an unrecognized name
 */
function typeFromName(name: unknown): SchemaValueType | undefined {
  switch (name) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'array':
    case 'object':
      return name;
    case 'integer':
      return 'number';
    default:
      return undefined;
  }
}

/**
 * Types the node's own `type`, `const` or `enum` admits.
 * @param node - Schema object
 * @returns The admitted types, or `undefined` when the node does not restrict them
 */
function ownTypes(node: JsonSchema): Set<SchemaValueType> | undefined {
  const type = ownValue(node, 'type');
  if (typeof type === 'string' || Array.isArray(type)) {
    const names: unknown[] = Array.isArray(type) ? type : [type];
    return new Set(names.flatMap((name) => typeFromName(name) ?? []));
  }
  if (Object.hasOwn(node, 'const')) return new Set([jsonValueType(ownValue(node, 'const'))]);
  const values = ownValue(node, 'enum');
  if (Array.isArray(values)) return new Set(values.map(jsonValueType));
  return undefined;
}

/**
 * Intersect two type restrictions; `undefined` means unrestricted.
 * @param left - First restriction
 * @param right - Second restriction
 * @returns The intersection
 */
function intersectTypes(
  left: ReadonlySet<SchemaValueType> | undefined,
  right: ReadonlySet<SchemaValueType> | undefined,
): ReadonlySet<SchemaValueType> | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return new Set([...left].filter((type) => right.has(type)));
}

/**
 * Describe a schema value, following references and combinators.
 * @param value - Schema value (object or boolean)
 * @param root - Root schema for `$ref`
 * @param refs - References followed so far, to cut cycles
 * @returns The value description
 */
function describe(value: unknown, root: JsonSchema, refs: ReadonlySet<string>): SchemaValueDescription {
  if (value === false) return { types: new Set(), dateTime: false };
  if (!isSchemaObject(value)) return { types: undefined, dateTime: false };

  const conjuncts: SchemaValueDescription[] = [
    { types: ownTypes(value), dateTime: ownValue(value, 'format') === 'date-time' },
  ];

  const ref = ownValue(value, '$ref');
  if (typeof ref === 'string' && !refs.has(ref)) {
    const target = resolveRef(ref, root);
    if (target !== undefined) conjuncts.push(describe(target, root, new Set([...refs, ref])));
  }
  for (const branch of branchesOf(value, 'allOf')) {
    conjuncts.push(describe(branch, root, refs));
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = branchesOf(value, keyword);
    if (branches.length > 0) {
      conjuncts.push(describeAlternatives(branches.map((branch) => describe(branch, root, refs))));
    }
  }

  return {
    types: conjuncts.reduce<ReadonlySet<SchemaValueType> | undefined>(
      (types, conjunct) => intersectTypes(types, conjunct.types),
      undefined,
    ),
    dateTime: conjuncts.some((conjunct) => conjunct.dateTime),
  };
}

/**
 * Describe a value that matches any of several alternatives.
 *
 * Strings are date-times only when every alternative that admits a string requires it.
 * @param alternatives - Descriptions of the alternatives, at least one
 * @returns The combined description
 */
function describeAlternatives(alternatives: readonly SchemaValueDescription[]): SchemaValueDescription {
  const types = alternatives.some((alternative) => alternative.types === undefined)
    ? undefined
    : new Set(alternatives.flatMap((alternative) => [...(alternative.types ?? [])]));
  const stringAlternatives = alternatives.filter(
    (alternative) => alternative.types === undefined || alternative.types.has('string'),
  );
  const dateTime = stringAlternatives.length > 0 && stringAlternatives.every((alternative) => alternative.dateTime);
  return { types, dateTime };
}

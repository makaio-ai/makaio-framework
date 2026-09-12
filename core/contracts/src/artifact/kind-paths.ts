import type { z } from 'zod';

/**
 * Narrow a JSON Schema object without accepting arrays or primitive schemas.
 * @param value - Schema candidate.
 * @returns An object schema, when present.
 */
function schemaObject(value: unknown): Record<string, unknown> | undefined {
  return isSchemaObject(value) ? value : undefined;
}

/**
 * Recognize an object whose named fields can be inspected independently.
 * @param value - Candidate schema node.
 * @returns Whether the candidate has object properties rather than array entries.
 */
function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Determine whether a schema node unconditionally declares exactly one type.
 *
 * Accepts both the shorthand string form (`type: 'array'`) and the singleton
 * array form (`type: ['array']`). A multi-member type array
 * (`type: ['array','null']`) is rejected — a possibly-null value is not guaranteed
 * to carry the expected type, and turning that false rejection into a false
 * acceptance would weaken registration-time safety.
 * @param node - Schema node to inspect.
 * @param expected - JSON Schema primitive type name to match.
 * @returns Whether the node unconditionally declares exactly this type.
 */
export function declaresType(node: unknown, expected: string): boolean {
  if (!isSchemaObject(node)) return false;
  const t = node.type;
  if (t === expected) return true;
  return Array.isArray(t) && t.length === 1 && t[0] === expected;
}

/** One schema declaration reachable at an inspected location. */
export type ArtifactSchemaFragment = boolean | Record<string, unknown>;

/**
 * Location segment selecting one element of a declared array.
 *
 * Named-property paths cannot express it, so callers that address list entries
 * — a write addressing one collection entry, for instance — substitute this
 * token for the concrete position or match that selects the element. Schema
 * inspection is identical for either, because both resolve to the array's
 * declared item schema.
 *
 * The brackets are what make the token unambiguous: {@link ArtifactDataPathSchema}
 * admits no bracket in a property name, so no real property can be mistaken for
 * an element selector when a dotted path is split into segments.
 */
export const ARTIFACT_COLLECTION_ELEMENT_SEGMENT = '[]';

/**
 * Apply draft 2020-12 sibling constraints to a boolean reference target.
 * @param target - Boolean target reached through a local reference.
 * @param siblings - Constraints declared alongside the reference.
 * @returns The equivalent schema fragment.
 */
function applyBooleanReferenceSiblings(target: boolean, siblings: Record<string, unknown>): ArtifactSchemaFragment {
  if (Object.keys(siblings).length === 0) return target;
  return target ? siblings : false;
}

/**
 * Look up a fragment target without following further references.
 * @param root - Root schema.
 * @param ref - Fragment reference.
 * @returns The immediate target, or undefined when the pointer cannot be resolved.
 */
function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  // Preserve existing ~0/~1 token handling; URI percent decoding is not part of
  // this lookup. Intermediate array positions are not supported by this profile.
  for (const part of ref.slice(2).split('/')) {
    const object = schemaObject(node);
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!object || !Object.hasOwn(object, key)) return undefined;
    node = object[key];
  }
  return node;
}

/**
 * Resolve a local JSON Schema reference.
 * @param root - Root schema.
 * @param source - Reference node, including dialect-dependent sibling constraints.
 * @returns The referenced schema fragment, when resolvable.
 */
function resolveRef(
  root: Record<string, unknown>,
  source: Record<string, unknown>,
): ArtifactSchemaFragment | undefined {
  const ref = source.$ref;
  if (typeof ref !== 'string') return undefined;
  const target = resolvePointer(root, ref);
  if (typeof target === 'boolean') {
    if (root.$schema !== 'https://json-schema.org/draft/2020-12/schema') return target;
    const { $ref: _reference, ...siblings } = source;
    return applyBooleanReferenceSiblings(target, siblings);
  }
  const schema = schemaObject(target);
  if (!schema || root.$schema !== 'https://json-schema.org/draft/2020-12/schema') return schema;
  const { $ref: _reference, ...siblings } = source;
  if (Object.keys(siblings).length === 0) return schema;
  return { ...schema, allOf: [siblings, ...(Array.isArray(schema.allOf) ? schema.allOf : [])] };
}

/**
 * Combine property constraints without overwriting a conjunct's restrictions.
 * @param target - Accumulated property declarations.
 * @param source - Additional property declarations.
 */
function mergePropertyDeclarations(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, constraint] of Object.entries(source)) {
    target[key] = Object.hasOwn(target, key) ? { allOf: [target[key], constraint] } : constraint;
  }
}

/**
 * Read required property names from a schema declaration.
 * @param node - Object schema declaration.
 * @returns Its declared required property names.
 */
function requiredProperties(node: Record<string, unknown>): string[] {
  return Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === 'string') : [];
}

/**
 * Read a declared object property without following the prototype chain.
 * @param node - Object schema containing properties.
 * @param key - Data-relative property name.
 * @returns The property's schema fragment, when declared.
 */
function declaredPropertySchema(node: Record<string, unknown>, key: string): ArtifactSchemaFragment | undefined {
  const properties = schemaObject(node.properties);
  if (!properties || !Object.hasOwn(properties, key)) return undefined;
  const property = properties[key];
  return typeof property === 'boolean' ? property : schemaObject(property);
}

/**
 * Combine object intersections for property lookup, retaining shared constraints.
 * This is schema inspection only; payload validation remains the schema engine's job.
 * Declared path/type coverage does not prove that the complete schema is satisfiable;
 * the original schema, including closed boundaries and value constraints, validates writes.
 * @param root - Root schema for resolving local references.
 * @param node - Current conjunctive schema.
 * @param refs - References visited at this schema position.
 * @returns Combined declarations, or undefined for contradictory/unsupported shapes.
 */
function combineConjuncts(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  refs: Set<string>,
): Record<string, unknown> | undefined {
  if (typeof node.$ref === 'string') {
    if (refs.has(node.$ref)) return undefined;
    const target = resolveRef(root, node);
    return isSchemaObject(target) ? combineConjuncts(root, target, new Set([...refs, node.$ref])) : undefined;
  }
  if (!Array.isArray(node.allOf)) return node;
  const { allOf, ...base } = node;
  const combined: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const candidate of [base, ...allOf]) {
    const object = schemaObject(candidate);
    const branch = object ? combineConjuncts(root, object, refs) : undefined;
    if (!branch || branch.anyOf || branch.oneOf) return undefined;
    if (branch.type !== undefined) {
      if (combined.type !== undefined && combined.type !== branch.type) return undefined;
      combined.type = branch.type;
    }
    // An intersected array keeps its item declarations (including draft-2020-12
    // prefixItems, so composed tuples reach validatePartArea's tuple check).
    // Two conjuncts declaring the same item keyword would need a real item
    // intersection, which is outside the supported profile.
    for (const key of ['items', 'prefixItems'] as const) {
      if (branch[key] !== undefined) {
        if (combined[key] !== undefined) return undefined;
        combined[key] = branch[key];
      }
    }
    mergePropertyDeclarations(properties, schemaObject(branch.properties) ?? {});
    for (const key of requiredProperties(branch)) required.add(key);
  }
  return { ...combined, properties, required: [...required] };
}

/**
 * Resolve one local reference while preserving terminal boolean schema semantics.
 * @param root - Root schema used for local reference resolution.
 * @param node - Reference schema node.
 * @param ref - Local reference identifier.
 * @param parts - Remaining data-relative property names.
 * @param required - Whether each path segment must be required.
 * @param refs - References already traversed at this position.
 * @param objectGuaranteed - Whether the artifact envelope guarantees an object at this location.
 * @param requiredAfterElement - Whether property segments must be required once an element
 *   boundary has been crossed. Consumed at the boundary; does not reactivate for nested elements.
 * @returns All matching schema fragments, or undefined when the reference cannot satisfy the path.
 */
function fieldSchemasForReference(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  ref: string,
  parts: string[],
  required: boolean,
  refs: Set<string>,
  objectGuaranteed: boolean,
  requiredAfterElement: boolean,
): ArtifactSchemaFragment[] | undefined {
  if (refs.has(ref)) return undefined;
  const target = resolveRef(root, node);
  if (typeof target === 'boolean') return parts.length === 0 ? [target] : undefined;
  return target
    ? fieldSchemas(root, target, parts, required, new Set([...refs, ref]), objectGuaranteed, requiredAfterElement)
    : undefined;
}

/**
 * Descend into the declared item schema of an array.
 *
 * An element is never a required property, so the required-property rule that
 * applies to object segments has nothing to check here and is not carried on.
 *
 * An element selector resolves to the homogeneous item schema only. Tuple
 * positions (`prefixItems`, or an array-valued draft-7 `items`) are outside the
 * inspected profile: the patch engine collapses a position and a filter to the
 * same element token before the schema is consulted, so no concrete index is
 * available here. No registered kind is a tuple today; a positional value that
 * violates a tuple slot is still rejected by schema re-validation of the
 * patched payload. Tracked in FACT-181.
 * @param root - Root schema for resolving local references.
 * @param node - Schema declared at the collection itself.
 * @param parts - Remaining segments below the element.
 * @param required - Whether each property segment below the element must be required.
 * @returns Matching schemas below one element, or undefined when the location is not declared.
 */
function elementSchemas(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  parts: string[],
  required: boolean,
): ArtifactSchemaFragment[] | undefined {
  if (!declaresType(node, 'array')) return undefined;
  const items = node.items;
  if (typeof items === 'boolean') return parts.length === 0 ? [items] : undefined;
  const item = schemaObject(items);
  return item ? fieldSchemas(root, item, parts, required) : undefined;
}

/** Result of combining one union alternative with its union node's base keywords. */
type UnionBranchCombination = { node: Record<string, unknown>; ref?: string };

/**
 * Combine one union alternative with the union node's base keywords.
 *
 * A `$ref` alternative is resolved before wrapping so that a union-valued
 * target is distributed by the union path instead of reaching
 * {@link combineConjuncts}, which rejects anyOf/oneOf branches.
 * @param root - Root schema for reference resolution.
 * @param base - Union node keywords without the alternatives list.
 * @param object - One union alternative as a schema object.
 * @returns Combined node, plus the resolved reference to add to the cycle set.
 */
function combineUnionBranchNode(
  root: Record<string, unknown>,
  base: Record<string, unknown>,
  object: Record<string, unknown>,
): UnionBranchCombination {
  if (typeof object.$ref !== 'string') {
    return { node: { ...object, allOf: [base, ...(Array.isArray(object.allOf) ? object.allOf : [])] } };
  }
  const refTarget = resolveRef(root, object);
  if (!isSchemaObject(refTarget)) return { node: { allOf: [base, object] } };
  return {
    node: { ...refTarget, allOf: [base, ...(Array.isArray(refTarget.allOf) ? refTarget.allOf : [])] },
    ref: object.$ref,
  };
}

/**
 * Find schemas at an object-property path, requiring coverage in every union branch.
 * @param root - Root schema for resolving local references.
 * @param node - Current schema.
 * @param parts - Remaining object property names.
 * @param required - Whether all properties must be required.
 * @param refs - References already traversed at this position, preventing cycles.
 * @param objectGuaranteed - Whether the Artifact data envelope guarantees an object at this location.
 * @param requiredAfterElement - When `true`, switches `required` to `true` the first time an
 *   element boundary (`[]`) is crossed. Used by idPath validation to enforce requiredness only
 *   inside elements without also requiring the area property itself.
 * @returns All matching variant schemas, or undefined for an unsupported path.
 */
function fieldSchemas(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  parts: string[],
  required: boolean,
  refs = new Set<string>(),
  objectGuaranteed = false,
  requiredAfterElement = false,
): ArtifactSchemaFragment[] | undefined {
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    return fieldSchemasForReference(root, node, ref, parts, required, refs, objectGuaranteed, requiredAfterElement);
  }
  const unionKey = Array.isArray(node.anyOf) ? 'anyOf' : 'oneOf';
  const alternatives = node[unionKey];
  if (Array.isArray(alternatives)) {
    const { [unionKey]: _alternatives, ...base } = node;
    const results = alternatives.map((branch) => {
      const object = schemaObject(branch);
      if (!object) return undefined;
      const { node: combined, ref } = combineUnionBranchNode(root, base, object);
      const branchRefs = ref === undefined ? refs : new Set([...refs, ref]);
      return fieldSchemas(root, combined, parts, required, branchRefs, objectGuaranteed, requiredAfterElement);
    });
    return results.every((result) => result !== undefined) ? results.flatMap((result) => result ?? []) : undefined;
  }
  if (Array.isArray(node.allOf)) {
    const combined = combineConjuncts(root, node, refs);
    return combined
      ? fieldSchemas(root, combined, parts, required, refs, objectGuaranteed, requiredAfterElement)
      : undefined;
  }
  if (parts.length === 0) return [node];
  const [key, ...rest] = parts;
  if (key === ARTIFACT_COLLECTION_ELEMENT_SEGMENT) {
    // Activate requiredAfterElement at the boundary; clear it so nested element
    // crossings don't re-activate it (the flag is consumed here).
    return elementSchemas(root, node, rest, required || requiredAfterElement);
  }
  if (!declaresType(node, 'object') && !(node.type === undefined && objectGuaranteed)) return undefined;
  if (!key || (required && !requiredProperties(node).includes(key))) return undefined;
  return childStepSchemas(root, declaredPropertySchema(node, key), rest, required, requiredAfterElement);
}

/**
 * Descend into one declared property's schema for the remaining segments.
 * @param root - Root schema for resolving local references.
 * @param child - Declared property schema, or undefined when the property is not declared.
 * @param rest - Remaining location segments below the property.
 * @param required - Whether all further properties must be required.
 * @param requiredAfterElement - Requiredness activation flag for the next element boundary.
 * @returns Matching fragments, or undefined when the property is not declared.
 */
function childStepSchemas(
  root: Record<string, unknown>,
  child: ArtifactSchemaFragment | undefined,
  rest: string[],
  required: boolean,
  requiredAfterElement: boolean,
): ArtifactSchemaFragment[] | undefined {
  // The root envelope does not constrain the type of a nested property.
  if (typeof child === 'boolean') return rest.length === 0 ? [child] : undefined;
  return child ? fieldSchemas(root, child, rest, required, new Set(), false, requiredAfterElement) : undefined;
}

/**
 * Inspect the serialized schema fragments selected by one data-relative location.
 *
 * Segments name object properties, or select one element of a declared array
 * through {@link ARTIFACT_COLLECTION_ELEMENT_SEGMENT}. Multiple fragments
 * represent the location's coverage across all schema variants.
 * @param dataSchema - Serialized artifact data schema.
 * @param segments - Data-relative location segments.
 * @param options - Optional inspection modifiers. `required` (default `false`)
 *   requires every property segment from the root to appear in its enclosing
 *   object's `required` array. `requiredAfterElement` (default `false`) applies
 *   that check only to segments below the first element boundary (`[]`),
 *   leaving segments above it exempt — necessary when the area array itself may
 *   be optional.
 * @returns Covered schema fragments, or undefined when the location is not declared in every variant.
 */
export function inspectArtifactDataLocation(
  dataSchema: Record<string, unknown>,
  segments: readonly string[],
  options?: { readonly required?: boolean; readonly requiredAfterElement?: boolean },
): readonly ArtifactSchemaFragment[] | undefined {
  return fieldSchemas(
    dataSchema,
    dataSchema,
    [...segments],
    options?.required ?? false,
    new Set(),
    true,
    options?.requiredAfterElement ?? false,
  );
}

/**
 * Determine whether a data-relative path is declared in every schema variant.
 *
 * Paths traverse named object properties only. A terminal array is valid and
 * represents the complete original array; selecting its elements uses
 * {@link inspectArtifactDataLocation} with {@link ARTIFACT_COLLECTION_ELEMENT_SEGMENT}.
 * @param dataSchema - Serialized artifact data schema.
 * @param path - Data-relative object-property path.
 * @returns Whether the path is declared in every schema variant.
 */
export function isArtifactDataPathDeclared(dataSchema: Record<string, unknown>, path: string): boolean {
  return inspectArtifactDataLocation(dataSchema, path.split('.')) !== undefined;
}

/**
 * Enumerate child schemas without treating defaults/examples as declarations.
 * @param node - Parent schema.
 * @returns Child schema nodes and their relative diagnostic paths.
 */
function childSchemas(node: Record<string, unknown>): { node: Record<string, unknown>; path: (string | number)[] }[] {
  const children: { node: Record<string, unknown>; path: (string | number)[] }[] = [];
  const append = (value: unknown, path: (string | number)[]): void => {
    const child = schemaObject(value);
    if (child) children.push({ node: child, path });
  };
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']) {
    for (const [name, child] of Object.entries(schemaObject(node[key]) ?? {})) append(child, [key, name]);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']) {
    const values = node[key];
    if (Array.isArray(values)) values.forEach((child, index) => append(child, [key, index]));
  }
  for (const key of [
    'items',
    'additionalItems',
    'additionalProperties',
    'unevaluatedItems',
    'unevaluatedProperties',
    'propertyNames',
    'contains',
    'not',
    'if',
    'then',
    'else',
    'contentSchema',
  ])
    append(node[key], [key]);
  return children;
}

/**
 * Reject live schemas whose tuple arity cannot be serialized faithfully.
 * This guard applies only to Zod authoring. Explicit serialized JSON Schema
 * registrations retain their declared tuple constraints and are not restricted.
 * @param node - Serialized live schema to inspect.
 * @param path - Location used for an actionable authoring error.
 */
export function assertSupportedKindSerialization(
  node: Record<string, unknown>,
  path: (string | number)[] = ['dataSchema'],
): void {
  if (Array.isArray(node.prefixItems) || Array.isArray(node.items)) {
    throw new Error(
      `Unsupported tuple serialization at ${path.join('.')}: use an array schema or an explicit JSON Schema registration`,
    );
  }
  for (const child of childSchemas(node)) assertSupportedKindSerialization(child.node, [...path, ...child.path]);
}

/**
 * Conservatively detect independently closed objects anywhere in an intersection.
 * Even open outer objects can contain incompatible closed nested objects; proving
 * arbitrary intersection equivalence is outside the supported authoring contract.
 * @param root - Root schema used by local references.
 * @param node - Intersected schema tree.
 * @param refs - References already inspected along this traversal.
 * @returns Whether closed object composition or an unresolved reference is present.
 */
function containsClosedObject(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  refs = new Set<string>(),
): boolean {
  if (node.additionalProperties === false) return true;
  if (typeof node.$ref === 'string' && !refs.has(node.$ref)) {
    const target = resolveRef(root, node);
    if (
      target === undefined ||
      (isSchemaObject(target) && containsClosedObject(root, target, new Set([...refs, node.$ref])))
    )
      return true;
  }
  return childSchemas(node).some((child) => containsClosedObject(root, child.node, refs));
}

/**
 * Validate the supported reference profile and immediate fragment targets.
 * @param root - Root schema used for pointer lookup.
 * @param node - Current schema node.
 * @param ctx - Registration validation context.
 * @param path - Diagnostic path to the current schema node.
 */
function validateSchemaReferences(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (Object.hasOwn(node, '$ref') && typeof node.$ref !== 'string') {
    ctx.addIssue({ code: 'custom', path: [...path, '$ref'], message: 'Schema reference must be a string' });
  }
  // The registration profile is fragment-only. Even self-contained absolute $id
  // references that AJV could resolve are outside this deliberately narrow profile.
  if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, '$ref'],
      message:
        'Only fragment schema references are supported; absolute and document-relative references are outside the artifact registration profile',
    });
  }
  if (Object.hasOwn(node, '$anchor')) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, '$anchor'],
      message: 'Named schema anchors are not supported; use local JSON Pointer references',
    });
  }
  if (
    typeof node.$ref === 'string' &&
    node.$ref.startsWith('#') &&
    node.$ref.length > 1 &&
    !node.$ref.startsWith('#/')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, '$ref'],
      message: 'Named schema references are not supported; use local JSON Pointer references',
    });
  }
  if (typeof node.$ref === 'string' && (node.$ref === '#' || node.$ref.startsWith('#/'))) {
    const target = resolvePointer(root, node.$ref);
    if (!schemaObject(target) && typeof target !== 'boolean') {
      ctx.addIssue({
        code: 'custom',
        path: [...path, '$ref'],
        message: 'Fragment schema reference must resolve to an existing object or boolean schema',
      });
    }
  }
}

/**
 * Reject unsupported schema compositions explicitly.
 * The converter can merge these shapes differently from JSON Schema validators.
 * Open object intersections remain supported; closed objects must be authored as
 * a single schema instead of relying on intersected branches.
 * @param root - Root schema for local references.
 * @param node - Current schema node.
 * @param ctx - Registration validation context.
 * @param path - Diagnostic path to the current schema node.
 */
function validateSchemaCompositions(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  ctx: z.RefinementCtx,
  path: (string | number)[] = ['dataSchema'],
): void {
  // These capabilities require a different validator contract; reject them before
  // registration instead of allowing failed writes or unobserved async results.
  if (Object.hasOwn(node, '$async') && node.$async !== false) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, '$async'],
      message: 'Asynchronous artifact schemas are not supported',
    });
  }
  validateSchemaReferences(root, node, ctx, path);
  for (const keyword of ['anyOf', 'oneOf']) {
    const alternatives = node[keyword];
    if (Array.isArray(alternatives) && alternatives.some((branch) => typeof branch === 'boolean')) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, keyword],
        message: 'Unsupported boolean union alternative: use object schema declarations',
      });
    }
  }
  if (Array.isArray(node.allOf) && (containsClosedObject(root, node) || !combineConjuncts(root, node, new Set()))) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'allOf'],
      message: 'Unsupported intersection: use open compatible conjuncts or a single closed object schema',
    });
  }
  for (const child of childSchemas(node)) validateSchemaCompositions(root, child.node, ctx, [...path, ...child.path]);
}

/**
 * Validate declared data paths against their serialized schema.
 * @param value - Kind metadata containing fields and key selectors.
 * @param ctx - Zod validation context for actionable declaration errors.
 */
export function validateKindDataPaths(
  value: {
    dataSchema: Record<string, unknown>;
    titlePath: string;
    indexedFields?: string[];
    searchableFields?: string[];
    views?: Record<string, { fields: string[] }>;
    uniqueness?: { by: ({ kind: 'data'; path: string } | { kind: 'relation-target'; relationType: string })[] }[];
  },
  ctx: z.RefinementCtx,
): void {
  validateSchemaCompositions(value.dataSchema, value.dataSchema, ctx);
  const title = fieldSchemas(value.dataSchema, value.dataSchema, value.titlePath.split('.'), true, new Set(), true);
  if (!title?.length || title.some((field) => !declaresType(field, 'string'))) {
    ctx.addIssue({
      code: 'custom',
      path: ['titlePath'],
      message: 'titlePath must select a required string in every data schema variant',
    });
  }
  const paths = [
    ...(value.indexedFields ?? []).map((path, index) => ({ path, location: ['indexedFields', index] })),
    ...(value.searchableFields ?? []).map((path, index) => ({ path, location: ['searchableFields', index] })),
    ...(value.uniqueness ?? []).flatMap((rule, ri) =>
      rule.by.flatMap((selector, si) =>
        selector.kind === 'data' ? [{ path: selector.path, location: ['uniqueness', ri, 'by', si, 'path'] }] : [],
      ),
    ),
    ...Object.entries(value.views ?? {}).flatMap(([name, view]) =>
      view.fields.map((path, index) => ({ path, location: ['views', name, 'fields', index] })),
    ),
  ];
  for (const { path, location } of paths) {
    if (!isArtifactDataPathDeclared(value.dataSchema, path)) {
      ctx.addIssue({ code: 'custom', path: location, message: `Data path ${path} must select a declared field` });
    }
  }
}

/**
 * Read the mandatory human-readable title without changing its original text.
 * @param data - Validated artifact data.
 * @param titlePath - Data-relative property path declared by the kind.
 * @returns A nonblank title; throws when the kind's title invariant is violated.
 */
export function readArtifactTitle(data: Record<string, unknown>, titlePath: string): string {
  let value: unknown = data;
  for (const key of titlePath.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) {
      throw new Error(`Artifact title is missing at ${titlePath}`);
    }
    value = Reflect.get(value, key);
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Artifact title at ${titlePath} must be a nonblank string`);
  }
  return value;
}

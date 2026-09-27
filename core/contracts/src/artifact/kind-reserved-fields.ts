import { resolvePointer } from './kind-paths.js';

/**
 * Existential check for a top-level data property across every schema variant.
 *
 * This is the early, authoring-time signal for reserved envelope names. It is
 * best-effort: an open object schema (no `additionalProperties: false`)
 * declares nothing about a name, so the walker cannot see that its payloads may
 * carry it. The authoritative check runs at payload time in both validators —
 * the live-schema refinement of `defineArtifactKind` and the compiled checker
 * of `compileArtifactDataChecker`/`compileArtifactDataSchema` — which reject a
 * top-level own `slug` property whatever the schema shape.
 *
 * `isArtifactDataPathDeclared` answers "is this path declared in every
 * variant" — the right question for a title or an index. A reserved name needs
 * the opposite: "could any variant carry this property". This walker follows
 * local JSON Pointer `$ref`s (any depth, `~0`/`~1` escapes, resolved with the
 * same lookup the registration profile validates against), `allOf`/`anyOf`/
 * `oneOf`, `if`/`then`/`else`, `dependentSchemas` and object-valued draft-7
 * `dependencies` at the top level. It reports a property declared in
 * `properties`, matched by `patternProperties` (compiled with the `u` flag, as
 * Ajv does), listed in `required`, or listed in a property-name array under `dependentRequired` or array-valued draft-7
 * `dependencies` — a schema can demand a property it never describes, and that
 * payload carries the name all the same. Resolved `$ref` targets are treated as
 * variants of the root; the walker does not descend into nested object
 * properties: a reserved envelope name is only reserved at the top level of `data`.
 * `$ref` is the only reference keyword the walker needs: the registration
 * profile rejects `$dynamicRef`, `$dynamicAnchor`, `$recursiveRef` and
 * `$recursiveAnchor` (and named `$anchor`s), so no other reference can smuggle a
 * reserved property past it.
 */

/**
 * Narrow a JSON Schema node to a plain object.
 * @param value - Schema candidate.
 * @returns Whether the value is a non-array object.
 */
function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve a local JSON Pointer `$ref` against the root schema.
 * @param root - Root data schema the pointer is evaluated against.
 * @param ref - `$ref` value of the current node.
 * @returns The referenced schema, when the pointer resolves to an object schema.
 */
function resolveLocalRef(root: Record<string, unknown>, ref: unknown): Record<string, unknown> | undefined {
  if (typeof ref !== 'string') return undefined;
  const target = resolvePointer(root, ref);
  return isSchemaObject(target) ? target : undefined;
}

/**
 * Whether a dependency map lists a property name in any of its name arrays.
 * @param dependencies - `dependentRequired` or draft-7 `dependencies` value.
 * @param name - Property name to look for.
 * @returns `true` when an array-valued entry names the property.
 */
function dependencyRequires(dependencies: unknown, name: string): boolean {
  if (!isSchemaObject(dependencies)) return false;
  return Object.values(dependencies).some((entry) => Array.isArray(entry) && entry.includes(name));
}

/**
 * Whether one schema node declares, requires, or pattern-matches a property name.
 * @param node - Schema node to inspect.
 * @param name - Property name to look for.
 * @returns `true` when `properties`, `required`, or a dependency name array names it, or a `patternProperties` key matches it.
 */
function declaresProperty(node: Record<string, unknown>, name: string): boolean {
  const properties = node.properties;
  if (isSchemaObject(properties) && Object.hasOwn(properties, name)) return true;
  if (Array.isArray(node.required) && node.required.includes(name)) return true;
  if (dependencyRequires(node.dependentRequired, name) || dependencyRequires(node.dependencies, name)) return true;
  const patterns = node.patternProperties;
  if (!isSchemaObject(patterns)) return false;
  return Object.keys(patterns).some((pattern) => {
    try {
      return new RegExp(pattern, 'u').test(name);
    } catch {
      return false;
    }
  });
}

/**
 * Collect the top-level schema variants a node composes.
 * @param node - Schema node to inspect.
 * @returns Child schemas from `allOf`/`anyOf`/`oneOf`, `if`/`then`/`else`, `dependentSchemas`, and object-valued `dependencies`.
 */
function variantSchemas(node: Record<string, unknown>): Record<string, unknown>[] {
  const variants: Record<string, unknown>[] = [];
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const list = node[key];
    if (Array.isArray(list)) for (const entry of list) if (isSchemaObject(entry)) variants.push(entry);
  }
  for (const key of ['if', 'then', 'else']) {
    const entry = node[key];
    if (isSchemaObject(entry)) variants.push(entry);
  }
  for (const key of ['dependentSchemas', 'dependencies']) {
    const dependents = node[key];
    if (isSchemaObject(dependents))
      for (const entry of Object.values(dependents)) if (isSchemaObject(entry)) variants.push(entry);
  }
  return variants;
}

/**
 * Whether any top-level schema variant of `dataSchema` may carry `name`.
 * @param dataSchema - Serialized artifact data schema.
 * @param name - Top-level property name to look for.
 * @returns `true` when at least one reachable variant declares or pattern-matches the name.
 */
export function mayArtifactDataCarryProperty(dataSchema: Record<string, unknown>, name: string): boolean {
  const seen = new Set<Record<string, unknown>>();
  const visit = (node: Record<string, unknown>): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (declaresProperty(node, name)) return true;
    const target = resolveLocalRef(dataSchema, node.$ref);
    if (target && visit(target)) return true;
    return variantSchemas(node).some(visit);
  };
  return visit(dataSchema);
}

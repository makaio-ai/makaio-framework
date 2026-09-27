/**
 * Existential check for a top-level data property across every schema variant.
 *
 * `isArtifactDataPathDeclared` answers "is this path declared in every
 * variant" — the right question for a title or an index. A reserved name needs
 * the opposite: "could any variant carry this property". This walker follows
 * `$ref`, `allOf`/`anyOf`/`oneOf`, `if`/`then`/`else` and `dependentSchemas` at
 * the top level and reports a property declared in `properties` or matched by
 * `patternProperties`. It does not descend into nested object properties: a
 * reserved envelope name is only reserved at the top level of `data`.
 */

const REF_PREFIXES = ['#/$defs/', '#/definitions/'] as const;

/**
 * Narrow a JSON Schema node to a plain object.
 * @param value - Schema candidate.
 * @returns Whether the value is a non-array object.
 */
function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve a local `$ref` against the root schema's `$defs` or `definitions`.
 * @param root - Root data schema that owns the definitions.
 * @param ref - `$ref` value of the current node.
 * @returns The referenced schema, when it is a local definition.
 */
function resolveLocalRef(root: Record<string, unknown>, ref: unknown): Record<string, unknown> | undefined {
  if (typeof ref !== 'string') return undefined;
  for (const prefix of REF_PREFIXES) {
    if (!ref.startsWith(prefix)) continue;
    const container = root[prefix.slice(2, -1)];
    const target = isSchemaObject(container) ? container[ref.slice(prefix.length)] : undefined;
    return isSchemaObject(target) ? target : undefined;
  }
  return undefined;
}

/**
 * Whether one schema node declares or pattern-matches a property name.
 * @param node - Schema node to inspect.
 * @param name - Property name to look for.
 * @returns `true` when `properties` names it or a `patternProperties` key matches it.
 */
function declaresProperty(node: Record<string, unknown>, name: string): boolean {
  const properties = node.properties;
  if (isSchemaObject(properties) && Object.hasOwn(properties, name)) return true;
  const patterns = node.patternProperties;
  if (!isSchemaObject(patterns)) return false;
  return Object.keys(patterns).some((pattern) => {
    try {
      return new RegExp(pattern).test(name);
    } catch {
      return false;
    }
  });
}

/**
 * Collect the top-level schema variants a node composes.
 * @param node - Schema node to inspect.
 * @returns Child schemas from `allOf`/`anyOf`/`oneOf`, `if`/`then`/`else`, and `dependentSchemas`.
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
  const dependents = node.dependentSchemas;
  if (isSchemaObject(dependents))
    for (const entry of Object.values(dependents)) if (isSchemaObject(entry)) variants.push(entry);
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

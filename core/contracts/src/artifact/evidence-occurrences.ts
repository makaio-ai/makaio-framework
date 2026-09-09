import {
  ARTIFACT_VALUE_TYPE_KEYWORD,
  EVIDENCE_VALUE_TYPE,
  EvidenceValueSchema,
  type EvidenceValue,
} from './evidence.js';

/** One schema-declared evidence value and its location in an Artifact revision. */
export interface EvidenceOccurrence {
  readonly evidence: EvidenceValue;
  readonly dataPath: string;
}

export interface EvidenceOccurrenceExtractionOptions {
  /** Evaluate a branch at its pointer within the original root schema. */
  readonly matchesSchema: (rootSchema: Record<string, unknown>, schemaPointer: string, value: unknown) => boolean;
}

type JsonSchemaNode = Record<string, unknown>;

/** Convert an unknown schema fragment to an object node when possible.
 * @param value - Candidate JSON Schema fragment.
 * @returns The object node, or undefined for non-object schemas.
 */
function schemaNode(value: unknown): JsonSchemaNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchemaNode) : undefined;
}

/** Escape one token for use in a JSON Pointer.
 * @param value - Unescaped property name.
 * @returns The escaped pointer token.
 */
function escapePointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Resolve an RFC 6901 local reference against the root schema.
 * @param root - Root JSON Schema document.
 * @param ref - Local reference to resolve.
 * @returns The referenced object or boolean schema, or undefined when unresolved.
 */
function resolveLocalReference(
  root: JsonSchemaNode,
  ref: string,
): { node: JsonSchemaNode | boolean; pointer: string } | undefined {
  if (ref === '#') return { node: root, pointer: '' };
  if (!ref.startsWith('#/')) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  let current: unknown = root;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) return undefined;
      current = current[Number(key)];
    } else {
      const object = schemaNode(current);
      if (!object || !Object.hasOwn(object, key)) return undefined;
      current = object[key];
    }
  }
  const node = typeof current === 'boolean' ? current : schemaNode(current);
  return node === undefined ? undefined : { node, pointer };
}

/** Determine whether an exact schema path enters an embedded schema resource.
 * @param root - Root JSON Schema document.
 * @param pointer - Document-relative JSON Pointer of the active schema node.
 * @returns Whether a non-root node on the path declares its own `$id`.
 */
function hasNestedResourceOnPath(root: JsonSchemaNode, pointer: string): boolean {
  if (pointer === '') return false;
  let current: unknown = root;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    current = Array.isArray(current) ? current[Number(key)] : schemaNode(current)?.[key];
    if (typeof schemaNode(current)?.['$id'] === 'string') return true;
  }
  return false;
}

/** Parse a semantically marked node as canonical evidence.
 * @param node - Schema node being visited.
 * @param value - Artifact value at the current path.
 * @param path - Revision-local JSON Pointer.
 * @returns The occurrence when the node is marked, otherwise undefined.
 */
function markedOccurrence(node: JsonSchemaNode, value: unknown, path: string): EvidenceOccurrence | undefined {
  if (node[ARTIFACT_VALUE_TYPE_KEYWORD] !== EVIDENCE_VALUE_TYPE) return undefined;
  const parsed = EvidenceValueSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid schema-declared evidence at ${path}`);
  return { evidence: parsed.data, dataPath: path };
}

/** Conservatively probe one reference-bearing schema node for evidence semantics.
 * @param root - Root JSON Schema document.
 * @param node - Schema node that may contain a reference.
 * @param seen - Object nodes already inspected by the enclosing probe.
 * @param nestedResource - Whether the node belongs to a non-root schema resource.
 * @returns Whether the reference may reach evidence or cannot be resolved safely.
 */
function referencedSubtreeMayContainEvidence(
  root: JsonSchemaNode,
  node: JsonSchemaNode,
  seen: WeakSet<object>,
  nestedResource: boolean,
): boolean {
  if (typeof node['$ref'] !== 'string') return false;
  if (nestedResource) return true;
  const target = resolveLocalReference(root, node['$ref']);
  if (target === undefined) return true;
  return (
    typeof target.node !== 'boolean' &&
    containsEvidenceMarker(root, target.node, seen, hasNestedResourceOnPath(root, target.pointer))
  );
}

/** Determine whether a schema subtree contains the evidence semantic marker.
 * @param root - Root JSON Schema document.
 * @param candidate - Schema subtree to inspect.
 * @param seen - Object nodes already inspected while following references.
 * @param insideNestedResource - Whether the candidate belongs to a non-root schema resource.
 * @returns Whether the subtree can declare evidence semantics.
 */
function containsEvidenceMarker(
  root: JsonSchemaNode,
  candidate: unknown,
  seen = new WeakSet<object>(),
  insideNestedResource = false,
): boolean {
  const node = schemaNode(candidate);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  const nestedResource = insideNestedResource || (node !== root && typeof node['$id'] === 'string');
  if (node[ARTIFACT_VALUE_TYPE_KEYWORD] === EVIDENCE_VALUE_TYPE) return true;
  if (typeof node['$dynamicRef'] === 'string') return true;
  if (referencedSubtreeMayContainEvidence(root, node, seen, nestedResource)) return true;
  const singleSchemas = [
    'additionalItems',
    'additionalProperties',
    'contains',
    'else',
    'if',
    'items',
    'then',
    'unevaluatedItems',
    'unevaluatedProperties',
  ];
  if (singleSchemas.some((keyword) => containsEvidenceMarker(root, node[keyword], seen, nestedResource))) return true;
  const schemaArrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
  if (
    schemaArrays.some(
      (keyword) =>
        Array.isArray(node[keyword]) &&
        node[keyword].some((entry) => containsEvidenceMarker(root, entry, seen, nestedResource)),
    ) ||
    (Array.isArray(node['items']) &&
      node['items'].some((entry) => containsEvidenceMarker(root, entry, seen, nestedResource)))
  ) {
    return true;
  }
  for (const keyword of ['dependentSchemas', 'dependencies', 'patternProperties', 'properties']) {
    const schemas = schemaNode(node[keyword]);
    if (schemas && Object.values(schemas).some((entry) => containsEvidenceMarker(root, entry, seen, nestedResource)))
      return true;
  }
  return false;
}

class EvidenceSchemaWalker {
  private readonly occurrences = new Map<string, EvidenceOccurrence>();
  private readonly visited = new WeakMap<JsonSchemaNode, Set<string>>();

  public constructor(
    private readonly dataSchema: JsonSchemaNode,
    private readonly matchesSchema: EvidenceOccurrenceExtractionOptions['matchesSchema'],
  ) {}

  public extract(data: Record<string, unknown>): EvidenceOccurrence[] {
    this.visit(this.dataSchema, data, '/data');
    return [...this.occurrences.values()];
  }

  private visit(node: JsonSchemaNode, value: unknown, path: string, schemaPath = ''): void {
    const visitedPaths = this.visited.get(node) ?? new Set<string>();
    if (visitedPaths.has(path)) return;
    visitedPaths.add(path);
    this.visited.set(node, visitedPaths);

    if (typeof node['$dynamicRef'] === 'string') {
      throw new Error(`Evidence discovery does not support active $dynamicRef at ${path}`);
    }

    if (typeof node['$ref'] === 'string') {
      if (hasNestedResourceOnPath(this.dataSchema, schemaPath)) {
        throw new Error(`Evidence discovery does not support local $ref inside nested $id resource at ${path}`);
      }
      const target = resolveLocalReference(this.dataSchema, node['$ref']);
      if (target === undefined) throw new Error(`Cannot resolve local schema reference ${node['$ref']} at ${path}`);
      if (typeof target.node !== 'boolean') this.visit(target.node, value, path, target.pointer);
      if (this.dataSchema['$schema'] !== 'https://json-schema.org/draft/2020-12/schema') return;
    }

    const occurrence = markedOccurrence(node, value, path);
    if (occurrence) {
      this.occurrences.set(path, occurrence);
      return;
    }

    this.visitCombiners(node, value, path, schemaPath);
    this.visitConditional(node, value, path, schemaPath);
    this.visitDependencies(node, value, path, schemaPath);
    this.assertSupportedApplicators(node, path, schemaPath);
    if (Array.isArray(value)) this.visitArray(node, value, path, schemaPath);
    else if (value !== null && typeof value === 'object') this.visitObject(node, value, path, schemaPath);
  }

  private visitCombiners(node: JsonSchemaNode, value: unknown, path: string, schemaPath: string): void {
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const [index, candidate] of branches.entries()) {
        const branch = schemaNode(candidate);
        const branchPath = `${schemaPath}/${keyword}/${index}`;
        if (branch && (keyword === 'allOf' || this.matchesSchema(this.dataSchema, branchPath, value))) {
          this.visit(branch, value, path, branchPath);
        }
      }
    }
  }

  private visitConditional(node: JsonSchemaNode, value: unknown, path: string, schemaPath: string): void {
    const condition = typeof node['if'] === 'boolean' ? node['if'] : schemaNode(node['if']);
    if (condition === undefined) return;
    const conditionPath = `${schemaPath}/if`;
    const matches = this.matchesSchema(this.dataSchema, conditionPath, value);
    if (matches && typeof condition !== 'boolean') this.visit(condition, value, path, conditionPath);
    const keyword = matches ? 'then' : 'else';
    const selected = schemaNode(node[keyword]);
    if (selected) this.visit(selected, value, path, `${schemaPath}/${keyword}`);
  }

  private visitDependencies(node: JsonSchemaNode, value: unknown, path: string, schemaPath: string): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    for (const keyword of ['dependentSchemas', 'dependencies'] as const) {
      const dependencies = schemaNode(node[keyword]);
      if (!dependencies) continue;
      for (const [property, dependency] of Object.entries(dependencies)) {
        const dependentSchema = schemaNode(dependency);
        if (Object.hasOwn(value, property) && dependentSchema) {
          this.visit(dependentSchema, value, path, `${schemaPath}/${keyword}/${escapePointerToken(property)}`);
        }
      }
    }
  }

  private assertSupportedApplicators(node: JsonSchemaNode, path: string, schemaPath: string): void {
    for (const keyword of ['unevaluatedProperties', 'unevaluatedItems'] as const) {
      if (
        containsEvidenceMarker(
          this.dataSchema,
          node[keyword],
          undefined,
          hasNestedResourceOnPath(this.dataSchema, schemaPath),
        )
      ) {
        throw new Error(`Evidence under unsupported ${keyword} applicator at ${path}`);
      }
    }
  }

  private visitArray(node: JsonSchemaNode, value: unknown[], path: string, schemaPath: string): void {
    const prefixItems = Array.isArray(node['prefixItems']);
    const tuple = prefixItems ? (node['prefixItems'] as unknown[]) : Array.isArray(node['items']) ? node['items'] : [];
    tuple.forEach((candidate, index) => {
      const item = schemaNode(candidate);
      const keyword = prefixItems ? 'prefixItems' : 'items';
      if (item && index < value.length)
        this.visit(item, value[index], `${path}/${index}`, `${schemaPath}/${keyword}/${index}`);
    });
    const items = Array.isArray(node['items']) ? schemaNode(node['additionalItems']) : schemaNode(node['items']);
    if (items) {
      const keyword = Array.isArray(node['items']) ? 'additionalItems' : 'items';
      value
        .slice(tuple.length)
        .forEach((item, offset) =>
          this.visit(items, item, `${path}/${tuple.length + offset}`, `${schemaPath}/${keyword}`),
        );
    }
    this.visitContains(node, value, path, schemaPath);
  }

  private visitContains(node: JsonSchemaNode, value: unknown[], path: string, schemaPath: string): void {
    const contains = schemaNode(node['contains']);
    if (!contains) return;
    const containsPath = `${schemaPath}/contains`;
    value.forEach((item, index) => {
      if (this.matchesSchema(this.dataSchema, containsPath, item)) {
        this.visit(contains, item, `${path}/${index}`, containsPath);
      }
    });
  }

  private visitObject(node: JsonSchemaNode, value: object, path: string, schemaPath: string): void {
    const properties = schemaNode(node['properties']);
    const patterns = schemaNode(node['patternProperties']);
    for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
      const escapedKey = escapePointerToken(key);
      const declaredProperty = properties !== undefined && Object.hasOwn(properties, key);
      const child = schemaNode(properties?.[key]);
      if (child) this.visit(child, childValue, `${path}/${escapedKey}`, `${schemaPath}/properties/${escapedKey}`);
      const matchedPattern = this.visitPatterns(patterns, key, childValue, `${path}/${escapedKey}`, schemaPath);
      const additional = schemaNode(node['additionalProperties']);
      if (!declaredProperty && !matchedPattern && additional) {
        this.visit(additional, childValue, `${path}/${escapedKey}`, `${schemaPath}/additionalProperties`);
      }
    }
  }

  private visitPatterns(
    patterns: JsonSchemaNode | undefined,
    key: string,
    value: unknown,
    path: string,
    schemaPath: string,
  ): boolean {
    let matched = false;
    for (const [pattern, candidate] of Object.entries(patterns ?? {})) {
      if (!new RegExp(pattern, 'u').test(key)) continue;
      matched = true;
      const patternSchema = schemaNode(candidate);
      if (patternSchema) {
        this.visit(patternSchema, value, path, `${schemaPath}/patternProperties/${escapePointerToken(pattern)}`);
      }
    }
    return matched;
  }
}

/**
 * Discover canonical evidence values by following a Kind's serialized data schema.
 *
 * Only nodes carrying the shared EvidenceValue semantic annotation are emitted.
 * Schema annotations such as examples and defaults, and evidence-shaped values in
 * unmarked fields, are never inspected as evidence.
 * Active `$dynamicRef`, local references within nested `$id` resources, and marked
 * `unevaluatedProperties` / `unevaluatedItems` applicators fail visibly because this
 * bounded walker cannot preserve their evaluation-scope semantics.
 * @param dataSchema - Serialized Artifact Kind data schema.
 * @param data - Kind-validated Artifact data.
 * @param options - Host-owned JSON Schema branch evaluator.
 * @returns Evidence values paired with revision-local JSON Pointer paths.
 */
export function extractEvidenceOccurrences(
  dataSchema: Record<string, unknown>,
  data: Record<string, unknown>,
  options: EvidenceOccurrenceExtractionOptions,
): EvidenceOccurrence[] {
  return new EvidenceSchemaWalker(dataSchema, options.matchesSchema).extract(data);
}

import { JsonValueSchema, type JsonSchema, type JsonValue } from '@makaio/contracts';
import { type RuleFinding, type ValueExpr, ValueExprSchema } from '@makaio/contracts/rules';
import { isJsonObject, readDotPath } from '@makaio/contracts/shared';
import { resolveSchemaPath } from '@makaio/rules';
import { pointerKey, scopeSchema } from './schema-scope.js';

/** The outer parameter record has named fields even when it resembles an expression. */
export type ParameterRoot = 'value' | 'record';

/** Recognize only the three exact expression shapes reserved by ParamTree.
 * @param tree - Parameter tree node.
 * @param root - Whether this node is a parameter record or a value.
 * @returns The expression, if this node has one of the reserved shapes.
 */
export function expression(tree: unknown, root: ParameterRoot = 'value'): ValueExpr | undefined {
  if (root === 'record' || !isJsonObject(tree) || Object.keys(tree).length !== 1) return undefined;
  return ValueExprSchema.safeParse(tree).data;
}

/** Resolve expressions against the current facts. Missing references propagate to the caller.
 * @param tree - Parameter tree to expand.
 * @param facts - Available facts by root.
 * @param root - Whether the root has named parameters or is a value.
 * @returns Expanded JSON, or undefined if a reference is missing.
 */
export function resolveParameters(tree: unknown, facts: object, root: ParameterRoot = 'value'): JsonValue | undefined {
  const expr = expression(tree, root);
  if (expr && 'literal' in expr) return expr.literal;
  if (expr && 'ref' in expr) {
    const value = JsonValueSchema.safeParse(readDotPath(facts, expr.ref));
    return value.success ? value.data : undefined;
  }
  if (expr && 'template' in expr) {
    let missing = false;
    const result = expr.template.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) => {
      const value = readDotPath(facts, path.trim());
      missing ||= value === undefined;
      return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
    });
    return missing ? undefined : result;
  }
  if (tree === null || typeof tree !== 'object') return JsonValueSchema.safeParse(tree).data;
  const entries = Object.entries(tree).map(([key, value]) => ({
    key,
    value: resolveParameters(value, facts),
  }));
  const resolved = entries.flatMap(({ key, value }) => (value === undefined ? [] : [[key, value] as const]));
  if (resolved.length !== entries.length) return undefined;
  return Array.isArray(tree) ? resolved.map(([, value]) => value) : Object.fromEntries(resolved);
}

/** Build a closed JSON Schema object from available properties.
 * @param properties - Schemas by property name.
 * @param required - Properties always present.
 * @returns JSON Schema of the object.
 */
export function objectSchema(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
  const scoped = Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [key, scopeSchema(schema, '#/properties/' + pointerKey(key))]),
  );
  return { type: 'object', properties: scoped, required, additionalProperties: false };
}

/** Resolve a referenced fact schema and report misspellings.
 * @param roots - Available facts by root.
 * @param ref - Dot-notation fact path.
 * @param path - Location of the reference.
 * @param findings - Accumulator for diagnostics.
 * @returns Schema and its original root, when known.
 */
export function factSchema(roots: JsonSchema, ref: string, path: string, findings: RuleFinding[]) {
  const segments = ref.split('.');
  const resolved = resolveSchemaPath(roots, segments);
  if (resolved.kind === 'unknown') {
    const code = resolveSchemaPath(roots, segments.slice(0, 1)).kind === 'unknown' ? 'unknown-root' : 'unknown-path';
    findings.push({ severity: 'error', code, path, message: `Unknown fact '${ref}'` });
  }
  return resolved.kind === 'known' ? resolved.schema : undefined;
}

/** Check that references in a parameter tree name available facts.
 * @param tree - Parameter tree.
 * @param roots - Available rule facts.
 * @param path - Location of the parameter tree.
 * @param findings - Accumulator for diagnostics.
 * @param root - Whether this node is a parameter record or a value.
 */
export function checkParameterReferences(
  tree: unknown,
  roots: JsonSchema,
  path: string,
  findings: RuleFinding[],
  root?: ParameterRoot,
): void {
  const expr = expression(tree, root);
  if (expr && 'ref' in expr) {
    factSchema(roots, expr.ref, path, findings);
  } else if (expr && 'template' in expr) {
    for (const match of expr.template.matchAll(/\{\{([^{}]+)\}\}/g)) {
      factSchema(roots, match[1]!.trim(), path, findings);
    }
  }
  if (expr || tree === null || typeof tree !== 'object') return;
  for (const [key, value] of Object.entries(tree)) {
    checkParameterReferences(value, roots, `${path}.${key}`, findings);
  }
}

import type { JsonObject, MakaioProtocolSubject, ProtocolExportAuditCheckResult } from './types.js';
import { isJsonObject } from './export-manifest-json-utils.js';

/**
 * Extract all embedded JSON Schema objects from a manifest subject.
 * @param subject - Manifest subject to extract schemas from
 * @returns Array of `[label, schema]` pairs ready for representability checks
 */
function extractSubjectSchemas(subject: MakaioProtocolSubject): Array<[string, JsonObject]> {
  if (subject.kind === 'request') {
    return [
      ['requestSchema', subject.requestSchema],
      ['responseSchema', subject.responseSchema],
    ];
  }

  return [['payloadSchema', subject.payloadSchema]];
}

/**
 * Recurse into a JSON object map (e.g. `properties` or `$defs`) and return the first
 * non-representable pattern found across all values, or `null` when all are representable.
 * @param map - JSON object whose values are JSON Schema nodes
 * @param basePath - Dot-separated path prefix for error messages
 * @returns Non-representable pattern description, or `null` if all values are representable
 */
function findNonRepresentableInMap(map: JsonObject, basePath: string): string | null {
  for (const [key, value] of Object.entries(map)) {
    if (isJsonObject(value)) {
      const issue = findNonRepresentablePattern(value, `${basePath}.${key}`);
      if (issue !== null) return issue;
    }
  }
  return null;
}

/**
 * Check whether a JSON Schema node contains patterns that cannot be represented as Rust structs.
 * Returns the first non-representable pattern description found, or `null` when the node is
 * fully representable. The check is intentionally conservative: it rejects the schema keywords
 * that are known to break the current Rust model generator, but it is not a complete proof that
 * an arbitrary JSON Schema can map to Rust structs.
 * @param schema - JSON Schema node to inspect
 * @param path - Dot-separated schema path used in error messages (e.g. `"properties.args"`)
 * @returns Non-representable pattern description, or `null` if representable
 */
function findNonRepresentablePattern(schema: JsonObject, path: string): string | null {
  if ('not' in schema) {
    return `${path}: 'not' keyword cannot be represented as a Rust type`;
  }

  if ('if' in schema) {
    return `${path}: 'if/then/else' conditional schema cannot be represented as a Rust type`;
  }

  if ('patternProperties' in schema) {
    return `${path}: 'patternProperties' cannot become Rust struct fields`;
  }

  // Recurse into named sub-schema maps: 'properties' and '$defs'
  for (const keyword of ['properties', '$defs'] as const) {
    if (isJsonObject(schema[keyword])) {
      const issue = findNonRepresentableInMap(schema[keyword] as JsonObject, `${path}.${keyword}`);
      if (issue !== null) return issue;
    }
  }

  // Recurse into combinator/tuple array schemas: oneOf, anyOf, allOf, prefixItems
  for (const keyword of ['oneOf', 'anyOf', 'allOf', 'prefixItems'] as const) {
    const members = schema[keyword];
    if (Array.isArray(members)) {
      for (let index = 0; index < members.length; index += 1) {
        const member = members[index];
        if (isJsonObject(member)) {
          const issue = findNonRepresentablePattern(member, `${path}.${keyword}[${index}]`);
          if (issue !== null) return issue;
        }
      }
    }
  }

  // Recurse into 'items' for array element schemas.
  // Draft 2019-09 and earlier allow items to be an array of schemas (tuple form).
  if (Array.isArray(schema.items)) {
    for (let index = 0; index < schema.items.length; index += 1) {
      const item = schema.items[index];
      if (isJsonObject(item)) {
        const issue = findNonRepresentablePattern(item, `${path}.items[${index}]`);
        if (issue !== null) return issue;
      }
    }
  } else if (isJsonObject(schema.items)) {
    const issue = findNonRepresentablePattern(schema.items, `${path}.items`);
    if (issue !== null) return issue;
  }

  // Recurse into 'additionalProperties' only when it is a schema object — a plain boolean
  // or absent value is always representable. An object additionalProperties means the struct
  // becomes a HashMap-like type, which is fine, but we still need to check the value schema
  // for non-representable sub-patterns.
  if (isJsonObject(schema.additionalProperties)) {
    const issue = findNonRepresentablePattern(schema.additionalProperties, `${path}.additionalProperties`);
    if (issue !== null) return issue;
  }

  return null;
}

/**
 * Default Rust model representability checker.
 * Walks the JSON Schema tree for each embedded schema and flags patterns that cannot be
 * represented as Rust structs by the Makaio Rust SDK code generator.
 * @param subject - Manifest subject whose schemas are checked for Rust representability
 * @returns Passed audit result when all schemas are representable, or failed with a
 *   descriptive message identifying the first non-representable pattern found
 */
export function defaultRustModelChecker(subject: MakaioProtocolSubject): ProtocolExportAuditCheckResult {
  for (const [label, schema] of extractSubjectSchemas(subject)) {
    const issue = findNonRepresentablePattern(schema, label);
    if (issue !== null) {
      return { status: 'failed', message: issue };
    }
  }

  return { status: 'passed' };
}

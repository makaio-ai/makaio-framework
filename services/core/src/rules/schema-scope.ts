import type { JsonValue } from '@makaio/contracts';
import { isJsonObject } from '@makaio/contracts/shared';

const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaValues = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
]);

/** Keep local JSON pointers relative to the contribution schema when embedding it.
 * @param schema - Schema being attached to a larger schema.
 * @param pointer - Its new location within the containing document.
 * @returns Schema fragment whose local pointers keep their original targets.
 */
export function scopeSchema(schema: JsonValue, pointer: string): JsonValue {
  if (!isSchemaMap(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([keyword, value]) => [keyword, scopeKeyword(keyword, value, pointer)]),
  );
}

/** @param keyword - JSON Schema keyword.
 * @param value - Its original value.
 * @param pointer - New schema location.
 * @returns Rebased keyword value. Literal instance data is copied unchanged.
 */
function scopeKeyword(keyword: string, value: JsonValue, pointer: string): JsonValue {
  if (keyword === '$ref' && typeof value === 'string' && (value === '#' || value.startsWith('#/'))) {
    return pointer + value.slice(1);
  }
  if (schemaMaps.has(keyword) && isSchemaMap(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, scopeSchema(nested, pointer)]));
  }
  if ((schemaLists.has(keyword) || keyword === 'items') && Array.isArray(value)) {
    return value.map((nested) => scopeSchema(nested, pointer));
  }
  return schemaValues.has(keyword) ? scopeSchema(value, pointer) : value;
}

/** @param key - Property key.
 * @returns JSON Pointer representation of the key.
 */
export function pointerKey(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** @param value - JSON value in a declared schema.
 * @returns Whether the value contains named JSON entries.
 */
function isSchemaMap(value: JsonValue): value is Record<string, JsonValue> {
  return isJsonObject(value);
}

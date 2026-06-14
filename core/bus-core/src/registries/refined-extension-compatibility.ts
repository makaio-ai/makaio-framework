import { z } from 'zod';

const refinedObjectBaseFields = new WeakMap<z.ZodObject<z.ZodRawShape>, ReadonlyMap<string, z.ZodType>>();

/**
 * Extract literal value descriptors from a Zod literal schema.
 * @param schema - Literal schema to inspect.
 * @returns Runtime value descriptors, or undefined when unavailable.
 */
function literalValueDomain(schema: z.ZodLiteral): ReadonlySet<string> | undefined {
  const values = (schema._def as { values?: readonly unknown[] }).values;
  if (!values) return undefined;
  return new Set(values.map((value) => `literal:${typeof value}:${String(value)}`));
}

/**
 * Detect field-level checks that narrow a broad primitive domain.
 * @param schema - Field schema to inspect.
 * @returns True when the schema carries checks such as min/max/string formats.
 */
function hasFieldChecks(schema: z.ZodType): boolean {
  const checks = (schema._def as { checks?: readonly unknown[] }).checks;
  return Array.isArray(checks) && checks.length > 0;
}

/**
 * Build a small runtime output-domain model for safely comparable Zod fields.
 * @param schema - Field schema to inspect.
 * @param rejectChecked - Whether checked primitive schemas should be treated as unknown.
 * @returns Domain descriptors, or undefined when the field is too complex.
 */
function fieldValueDomain(schema: z.ZodType, rejectChecked = false): ReadonlySet<string> | undefined {
  const domain = new Set<string>();
  let inner = schema;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault ||
    inner instanceof z.ZodReadonly
  ) {
    if (inner instanceof z.ZodDefault) return undefined;
    if (inner instanceof z.ZodOptional) domain.add('undefined');
    if (inner instanceof z.ZodNullable) domain.add('null');
    inner = inner.unwrap() as z.ZodType;
  }

  if (rejectChecked && hasFieldChecks(inner)) return undefined;
  if (inner instanceof z.ZodLiteral) {
    const literalDomain = literalValueDomain(inner);
    if (!literalDomain) return undefined;
    for (const value of literalDomain) domain.add(value);
    return domain;
  }
  if (inner instanceof z.ZodString) domain.add('string');
  else if (inner instanceof z.ZodNumber) domain.add('number');
  else if (inner instanceof z.ZodBoolean) domain.add('boolean');
  else if (inner instanceof z.ZodBigInt) domain.add('bigint');
  else if (inner instanceof z.ZodDate) domain.add('date');
  else return undefined;

  return domain;
}

/**
 * Check whether every extension value also satisfies the original output domain.
 * @param original - Original object field schema.
 * @param extension - Extension field schema replacing the original field.
 * @returns True when the known extension domain is a subset of the original domain.
 */
function extensionFieldIsCompatible(original: z.ZodType, extension: z.ZodType): boolean {
  const originalDomain = fieldValueDomain(original, true);
  const extensionDomain = fieldValueDomain(extension);
  if (!originalDomain || !extensionDomain) return false;

  for (const value of extensionDomain) {
    if (originalDomain.has(value)) continue;
    const primitive = value.startsWith('literal:') ? value.slice('literal:'.length).split(':', 1)[0] : value;
    if (!originalDomain.has(primitive)) return false;
  }
  return true;
}

/**
 * Detect whether an object schema carries refinements that run after field parsing.
 * @param schema - Object schema to inspect.
 * @returns True when the object has registered refinement checks.
 */
function hasObjectRefinements(schema: z.ZodObject<z.ZodRawShape>): boolean {
  const checks = (schema._def as { checks?: readonly unknown[] }).checks;
  return Array.isArray(checks) && checks.length > 0;
}

/**
 * Resolve the original fields that a refined object's callbacks may depend on.
 * @param schema - Object schema to inspect.
 * @returns Field schemas present before any subject extensions were merged.
 */
function refinedObjectBaseFieldMap(schema: z.ZodObject<z.ZodRawShape>): ReadonlyMap<string, z.ZodType> {
  const tracked = refinedObjectBaseFields.get(schema);
  if (tracked) return tracked;

  const fields = new Map(Object.entries(schema.shape).map(([key, field]) => [key, field as z.ZodType]));
  refinedObjectBaseFields.set(schema, fields);
  return fields;
}

/**
 * Reject refined-object field overrides that can feed incompatible parsed values
 * into existing refinement callbacks.
 * @param schema - Original registered object schema.
 * @param extension - Extension shape to merge.
 * @param label - Human-readable label for error messages.
 */
export function assertCompatibleRefinedObjectExtension(
  schema: z.ZodObject<z.ZodRawShape>,
  extension: z.ZodRawShape,
  label: string,
): void {
  if (!hasObjectRefinements(schema)) return;

  const baseFields = refinedObjectBaseFieldMap(schema);
  for (const [key, extensionField] of Object.entries(extension)) {
    const originalField = baseFields.get(key);
    if (!originalField) continue;
    if (extensionFieldIsCompatible(originalField, extensionField as z.ZodType)) continue;
    throw new Error(
      `[MakaioBus] Cannot extend ${label}: field '${key}' overrides an incompatible refined schema field`,
    );
  }
}

/**
 * Carry base refined field ownership across Zod object extension clones.
 * @param original - Original refined object schema.
 * @param extended - Extended object schema that preserves the original refinements.
 */
export function trackRefinedObjectExtension(
  original: z.ZodObject<z.ZodRawShape>,
  extended: z.ZodObject<z.ZodRawShape>,
): void {
  if (!hasObjectRefinements(original)) return;
  refinedObjectBaseFields.set(extended, refinedObjectBaseFieldMap(original));
}

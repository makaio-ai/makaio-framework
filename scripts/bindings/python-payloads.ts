import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  JsonObject,
  MakaioProtocolEventSubject,
  MakaioProtocolManifest,
  MakaioProtocolRequestSubject,
  MakaioProtocolSubject,
} from '../../packages/contracts/src/protocol/types.js';
import { PYTHON_PAYLOADS_DIR } from '../lib/sdk-generation-paths.js';

// ---------------------------------------------------------------------------
// Name conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a camelCase identifier to snake_case, matching the regex used in
 * `_serialization.py` (`_CAMEL_BOUNDARY`).
 *
 * Handles consecutive uppercase sequences correctly:
 * - `adapterId` → `adapter_id`
 * - `newCwd`    → `new_cwd`
 * - `providerConfigId` → `provider_config_id`
 * @param name - camelCase identifier from a JSON Schema property key
 * @returns snake_case equivalent
 */
export function camelToSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Convert a single word or camelCase/underscore token to PascalCase.
 *
 * - `contextWindow` → `ContextWindow`
 * - `cwd`           → `Cwd`
 * - `message_delta` → `MessageDelta`
 * @param token - A word, camelCase token, or underscore-separated token
 * @returns PascalCase string
 */
function toPascalWord(token: string): string {
  // Insert boundary before transitions, then split and capitalise.
  const snake = token
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  return snake
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Derive a PascalCase class-name prefix from a fully-qualified protocol subject.
 *
 * Examples:
 * - `agent.complete`            → `AgentComplete`
 * - `agent.contextWindow.updated` → `AgentContextWindowUpdated`
 * - `agent.cwd.change`          → `AgentCwdChange`
 * - `tool.list`                 → `ToolList`
 * @param fullSubject - Fully-qualified subject key, e.g. `agent.contextWindow.updated`
 * @returns PascalCase class-name prefix without trailing suffix
 */
export function fullSubjectToPascalClass(fullSubject: string): string {
  return fullSubject.split('.').map(toPascalWord).join('');
}

// ---------------------------------------------------------------------------
// JSON Schema → Python type annotation
// ---------------------------------------------------------------------------

/**
 * Internal structure describing a Python field definition derived from a
 * JSON Schema property.
 */
interface PythonField {
  /** Python snake_case field name. */
  name: string;
  /** Python type annotation string, e.g. `str`, `float`, `Literal["a"] | None`. */
  typeAnnotation: string;
  /** Whether the field is optional (not in `required`). */
  optional: boolean;
}

/**
 * Internal structure describing a generated Python dataclass.
 */
interface PythonClassDefinition {
  /** Python class name. */
  name: string;
  /** Ordered Python field definitions. */
  fields: PythonField[];
}

/**
 * Internal context threaded through schema traversal.
 */
interface SchemaRenderContext {
  /** Nested classes collected before their parent class is rendered. */
  classes: PythonClassDefinition[];
}

/**
 * Map a primitive JSON Schema type string to its Python annotation.
 * @param jsonType - JSON Schema primitive type string
 * @returns Python type string, or `None` when the type is unrecognised
 */
function primitiveTypeAnnotation(jsonType: string): string | null {
  switch (jsonType) {
    case 'string':
      return 'str';
    case 'number':
      return 'float';
    case 'integer':
      return 'int';
    case 'boolean':
      return 'bool';
    case 'null':
      return 'None';
    default:
      return null;
  }
}

/**
 * Format a JSON Schema `enum` array as a Python `Literal[...]` annotation.
 * @param values - Array of enum values (expected to be strings or numbers)
 * @returns Python Literal annotation string, e.g. `Literal["a", "b"]`
 */
function enumToLiteral(values: readonly unknown[]): string {
  const literals = values.map((v) => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ');
  return `Literal[${literals}]`;
}

/**
 * Determine the Python type annotation for a JSON Schema node.
 *
 * The mapping follows the rules defined in the task specification:
 * - Primitive scalars map to `str`, `float`, `int`, `bool`
 * - `enum` arrays and `const` values map to `Literal[...]`
 * - `anyOf: [T, {type: "null"}]` maps to `T | None`
 * - `oneOf` object variants map to `Union[...]` of variant dataclasses
 * - Typed object properties map to nested dataclasses
 * - Untyped objects map to `dict[str, Any]`
 * - `array` maps to `list[T]` where T is derived from `items`
 * - Unknown or empty schemas map to `Any`
 * @param schema - JSON Schema node (may be empty for unknown/free-form types)
 * @returns Python type annotation string
 */
export function schemaToTypeAnnotation(schema: JsonObject): string {
  return schemaToTypeAnnotationInContext(schema, { classes: [] }, null);
}

/**
 * Determine the Python type annotation for a JSON Schema node and collect any
 * nested dataclasses needed to represent object structure.
 * @param schema - JSON Schema node (may be empty for unknown/free-form types)
 * @param context - Schema traversal context that receives nested classes
 * @param className - Class name to use when this schema becomes a dataclass
 * @returns Python type annotation string
 */
function schemaToTypeAnnotationInContext(
  schema: JsonObject,
  context: SchemaRenderContext,
  className: string | null,
): string {
  if (typeof schema !== 'object' || schema === null) {
    return 'Any';
  }

  // anyOf handling
  if (Array.isArray(schema['anyOf'])) {
    return anyOfToAnnotation(schema['anyOf'] as JsonObject[], context, className);
  }

  // oneOf object variants become explicit variant dataclasses. Other oneOf
  // shapes intentionally fall back because the Python SDK does not validate
  // payloads locally and cannot safely encode arbitrary JSON Schema unions.
  if (Array.isArray(schema['oneOf'])) {
    return oneOfToAnnotation(schema['oneOf'] as JsonObject[], context, className);
  }

  // enum on the schema itself
  if (Array.isArray(schema['enum'])) {
    return enumToLiteral(schema['enum'] as unknown[]);
  }

  if ('const' in schema) {
    return enumToLiteral([schema['const']]);
  }

  const type = schema['type'];

  if (type === 'object') {
    if (className !== null && isDataclassObjectSchema(schema)) {
      context.classes.push({ name: className, fields: schemaToFields(schema, context, className) });
      return className;
    }
    return 'dict[str, Any]';
  }

  if (type === 'array') {
    const items = schema['items'];
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      const itemClassName = className === null ? null : `${className}Item`;
      const itemType = schemaToTypeAnnotationInContext(items as JsonObject, context, itemClassName);
      return `list[${itemType}]`;
    }
    return 'list[Any]';
  }

  if (typeof type === 'string') {
    return primitiveTypeAnnotation(type) ?? 'Any';
  }

  // Empty schema or $ref etc. → fall back to Any
  return 'Any';
}

/**
 * Check whether a schema object has typed properties that can become a Python dataclass.
 * @param schema - JSON Schema object node
 * @returns Whether the schema has a concrete property map
 */
function isTypedObjectSchema(schema: JsonObject): boolean {
  const properties = schema['properties'];
  return properties !== undefined && typeof properties === 'object' && !Array.isArray(properties);
}

/**
 * Check whether a schema object can be represented as a Python dataclass with
 * the current SDK serializer.
 *
 * Property names with characters outside Python identifiers intentionally fall
 * back to `dict[str, Any]`: generating renamed fields would not round-trip
 * through the existing camelCase/snake_case serializer.
 * @param schema - JSON Schema object node
 * @returns Whether the object can safely become a generated dataclass
 */
function isDataclassObjectSchema(schema: JsonObject): boolean {
  if (!isTypedObjectSchema(schema)) {
    return false;
  }

  const properties = schema['properties'] as Record<string, JsonObject>;
  return Object.keys(properties).every((wireKey) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(wireKey));
}

/**
 * Convert a JSON Schema `anyOf` array to a Python type annotation.
 *
 * Handles the common pattern `anyOf: [T, {type: "null"}]` → `T | None`.
 * Complex anyOf with more than two non-null variants collapses to `dict[str, Any]`.
 * @param variants - The array of schema variants from `anyOf`
 * @param context - Schema traversal context that receives nested classes
 * @param className - Class name to use if the non-null variant becomes a dataclass
 * @returns Python type annotation string
 */
function anyOfToAnnotation(variants: JsonObject[], context: SchemaRenderContext, className: string | null): string {
  const nonNull = variants.filter((v) => v['type'] !== 'null');
  const hasNull = variants.some((v) => v['type'] === 'null');

  if (nonNull.length === 1) {
    const inner = schemaToTypeAnnotationInContext(nonNull[0], context, className);
    return hasNull ? `${inner} | None` : inner;
  }

  // Multiple non-null variants — collapse to dict[str, Any]
  return 'dict[str, Any]';
}

/**
 * Convert a JSON Schema `oneOf` array to a Python type annotation.
 *
 * Object variants with typed properties are represented as separate dataclasses
 * and a `Union[...]` annotation. Other oneOf shapes explicitly fall back to a
 * dictionary annotation because they cannot be represented safely as dataclasses.
 * @param variants - The array of schema variants from `oneOf`
 * @param context - Schema traversal context that receives variant classes
 * @param className - Class-name prefix for generated variant classes
 * @returns Python type annotation string
 */
function oneOfToAnnotation(variants: JsonObject[], context: SchemaRenderContext, className: string | null): string {
  if (className === null || variants.length === 0 || !variants.every(isDataclassObjectSchema)) {
    return 'dict[str, Any]';
  }

  const variantClassNames = variants.map((_variant, index) => `${className}Variant${variantSuffix(index)}`);
  for (let index = 0; index < variants.length; index++) {
    context.classes.push({
      name: variantClassNames[index],
      fields: schemaToFields(variants[index], context, variantClassNames[index]),
    });
  }

  return `Union[${variantClassNames.join(', ')}]`;
}

/**
 * Convert a zero-based oneOf variant index to a stable alphabetic suffix.
 * @param index - Zero-based oneOf variant index
 * @returns Alphabetic variant suffix, e.g. `A`, `B`, `AA`
 */
function variantSuffix(index: number): string {
  let n = index;
  let suffix = '';
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return suffix;
}

// ---------------------------------------------------------------------------
// Required-imports collector
// ---------------------------------------------------------------------------

/**
 * Internal helper to accumulate Python import names needed by the generated file.
 */
interface ImportSet {
  /** Whether `Any` is needed from `typing`. */
  needsAny: boolean;
  /** Whether `Literal` is needed from `typing`. */
  needsLiteral: boolean;
  /** Whether `Union` is needed from `typing`. */
  needsUnion: boolean;
}

/**
 * Scan a type annotation string to determine which `typing` imports it requires.
 * Mutates the given `ImportSet` in-place.
 * @param annotation - Python type annotation string to inspect
 * @param imports - Import set to update
 */
function collectAnnotationImports(annotation: string, imports: ImportSet): void {
  if (annotation.includes('Any')) {
    imports.needsAny = true;
  }
  if (annotation.includes('Literal')) {
    imports.needsLiteral = true;
  }
  if (annotation.includes('Union')) {
    imports.needsUnion = true;
  }
}

// ---------------------------------------------------------------------------
// Dataclass generation
// ---------------------------------------------------------------------------

/**
 * Derive the sorted list of Python fields from a JSON Schema object definition.
 *
 * Required fields come first (no default), then optional fields (default `None`),
 * both sub-lists sorted alphabetically by snake_case name for deterministic output.
 * @param schema - JSON Schema object node with `properties` and optional `required`
 * @param context - Schema traversal context that receives nested classes
 * @param ownerClassName - Dataclass name used as a prefix for nested class names
 * @returns Ordered array of Python field descriptors
 */
function schemaToFields(schema: JsonObject, context: SchemaRenderContext, ownerClassName: string): PythonField[] {
  const properties = schema['properties'];
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return [];
  }

  const required = new Set<string>(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);

  const requiredFields: PythonField[] = [];
  const optionalFields: PythonField[] = [];

  for (const [wireKey, propSchema] of Object.entries(properties as Record<string, JsonObject>)) {
    const snakeName = camelToSnake(wireKey);
    const isOptional = !required.has(wireKey);
    let annotation = schemaToTypeAnnotationInContext(
      propSchema ?? {},
      context,
      `${ownerClassName}${toPascalWord(wireKey)}`,
    );

    // If the field is optional and the annotation doesn't already include None,
    // wrap it with `| None`.
    if (isOptional && !annotation.includes('None')) {
      annotation = `${annotation} | None`;
    }

    const field: PythonField = { name: snakeName, typeAnnotation: annotation, optional: isOptional };

    if (isOptional) {
      optionalFields.push(field);
    } else {
      requiredFields.push(field);
    }
  }

  // Sort each group alphabetically for deterministic output
  requiredFields.sort((a, b) => a.name.localeCompare(b.name));
  optionalFields.sort((a, b) => a.name.localeCompare(b.name));

  return [...requiredFields, ...optionalFields];
}

/**
 * Render a frozen Python dataclass from a class name and list of fields.
 *
 * Produces a compact block without leading blank line so callers control spacing.
 * @param className - Python class name to use for the dataclass
 * @param fields - Ordered list of Python field descriptors
 * @returns Generated Python dataclass source lines
 */
function renderDataclass(className: string, fields: PythonField[]): string[] {
  const lines: string[] = [`@dataclass(frozen=True)`, `class ${className}:`];

  if (fields.length === 0) {
    lines.push('    pass');
  } else {
    for (const field of fields) {
      if (field.optional) {
        lines.push(`    ${field.name}: ${field.typeAnnotation} = None`);
      } else {
        lines.push(`    ${field.name}: ${field.typeAnnotation}`);
      }
    }
  }

  return lines;
}

/**
 * Render a generated dataclass definition.
 * @param definition - Generated class definition
 * @returns Generated Python dataclass source lines
 */
function renderClassDefinition(definition: PythonClassDefinition): string[] {
  return renderDataclass(definition.name, definition.fields);
}

// ---------------------------------------------------------------------------
// Per-namespace payload file generator
// ---------------------------------------------------------------------------

/**
 * Derive a Python dataclass class name for a payload schema.
 *
 * Examples:
 * - `agent.complete` + `payload` → `AgentCompletePayload`
 * - `agent.credential.change` + `request` → `AgentCredentialChangeRequest`
 * @param fullSubject - Fully-qualified subject key
 * @param suffix - Class name suffix: `Payload`, `Request`, or `Response`
 * @returns Python class name string
 */
function payloadClassName(fullSubject: string, suffix: 'Payload' | 'Request' | 'Response'): string {
  return `${fullSubjectToPascalClass(fullSubject)}${suffix}`;
}

/**
 * Collect all dataclass definitions required for a single protocol event subject.
 * @param subject - Protocol event subject
 * @param classes - Output array to push class definitions into
 * @param imports - Import set to update based on annotations used
 */
function collectEventDataclasses(
  subject: MakaioProtocolEventSubject,
  classes: PythonClassDefinition[],
  imports: ImportSet,
): void {
  const className = payloadClassName(subject.fullSubject, 'Payload');
  const fields = schemaToFields(subject.payloadSchema, { classes }, className);
  for (const f of fields) {
    collectAnnotationImports(f.typeAnnotation, imports);
  }
  classes.push({ name: className, fields });
}

/**
 * Collect all dataclass definitions required for a single protocol request subject.
 * Both a request dataclass and a response dataclass are emitted.
 * @param subject - Protocol request subject
 * @param classes - Output array to push class definitions into
 * @param imports - Import set to update based on annotations used
 */
function collectRequestDataclasses(
  subject: MakaioProtocolRequestSubject,
  classes: PythonClassDefinition[],
  imports: ImportSet,
): void {
  const requestClassName = payloadClassName(subject.fullSubject, 'Request');
  const requestFields = schemaToFields(subject.requestSchema, { classes }, requestClassName);
  for (const f of requestFields) {
    collectAnnotationImports(f.typeAnnotation, imports);
  }
  classes.push({ name: requestClassName, fields: requestFields });

  const responseClassName = payloadClassName(subject.fullSubject, 'Response');
  const responseFields = schemaToFields(subject.responseSchema, { classes }, responseClassName);
  for (const f of responseFields) {
    collectAnnotationImports(f.typeAnnotation, imports);
  }
  classes.push({ name: responseClassName, fields: responseFields });
}

/**
 * Generate the Python payload dataclass module for one namespace.
 *
 * Each event subject contributes a `*Payload` dataclass; each request subject
 * contributes a `*Request` and a `*Response` dataclass.  All classes are
 * frozen dataclasses.  Required fields appear before optional fields within
 * each class.
 * @param namespace - Protocol namespace name, e.g. `agent`
 * @param subjects - Protocol subjects belonging to this namespace
 * @returns Generated Python source string for the payloads module
 */
export function generatePythonPayloadsModule(namespace: string, subjects: MakaioProtocolSubject[]): string {
  const imports: ImportSet = { needsAny: false, needsLiteral: false, needsUnion: false };
  const classes: PythonClassDefinition[] = [];

  for (const subject of subjects) {
    if (subject.kind === 'event') {
      collectEventDataclasses(subject, classes, imports);
    } else {
      collectRequestDataclasses(subject, classes, imports);
    }
  }

  for (const classDefinition of classes) {
    for (const field of classDefinition.fields) {
      collectAnnotationImports(field.typeAnnotation, imports);
    }
  }

  // Build typing imports
  const typingNames: string[] = [];
  if (imports.needsAny) typingNames.push('Any');
  if (imports.needsLiteral) typingNames.push('Literal');
  if (imports.needsUnion) typingNames.push('Union');

  const lines: string[] = [
    `"""${capitalize(namespace)} payload types — generated from makaio-bus-protocol.json."""`,
    '',
    'from __future__ import annotations',
    '',
    'from dataclasses import dataclass',
  ];

  if (typingNames.length > 0) {
    lines.push(`from typing import ${typingNames.join(', ')}`);
  }

  lines.push('');

  for (let i = 0; i < classes.length; i++) {
    if (i > 0) {
      // PEP 8: two blank lines between top-level class definitions
      lines.push('', '');
    }
    lines.push(...renderClassDefinition(classes[i]));
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Capitalise the first letter of a string.
 * @param s - Input string
 * @returns String with first character uppercased
 */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Namespace grouping
// ---------------------------------------------------------------------------

/**
 * Group protocol subjects by namespace, preserving sorted order within each group.
 * @param subjects - Protocol subjects from the manifest
 * @returns Map of namespace string to subjects in that namespace
 */
export function groupByNamespace(subjects: MakaioProtocolSubject[]): Map<string, MakaioProtocolSubject[]> {
  const groups = new Map<string, MakaioProtocolSubject[]>();

  for (const subject of subjects) {
    const existing = groups.get(subject.namespace);
    if (existing) {
      existing.push(subject);
    } else {
      groups.set(subject.namespace, [subject]);
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

/**
 * Write generated Python payload dataclass modules for every namespace in the manifest.
 *
 * Creates `<PYTHON_PAYLOADS_DIR>/<namespace>.py` for each namespace, plus an empty
 * `__init__.py` to make the directory a Python package.
 * @param manifest - Protocol manifest to generate payloads from
 * @returns Resolved paths of all written files
 */
export async function writePythonPayloads(manifest: MakaioProtocolManifest): Promise<string[]> {
  await mkdir(PYTHON_PAYLOADS_DIR, { recursive: true });

  const groups = groupByNamespace(manifest.subjects);
  const written: string[] = [];

  // Write an empty __init__.py to make the directory a Python package
  const initPath = resolve(PYTHON_PAYLOADS_DIR, '__init__.py');
  await writeFile(initPath, '"""Payload dataclass modules — generated from makaio-bus-protocol.json."""\n', 'utf8');
  written.push(initPath);

  for (const [namespace, subjects] of groups) {
    const content = generatePythonPayloadsModule(namespace, subjects);
    const filePath = resolve(PYTHON_PAYLOADS_DIR, `${namespace}.py`);
    await writeFile(filePath, content, 'utf8');
    written.push(filePath);
  }

  return written;
}

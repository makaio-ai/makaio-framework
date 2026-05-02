import * as ts from 'typescript';

import { relativeInventoryPath } from './path-utils.js';
import type { NamespaceKind, SubjectEntry, SubjectField } from './types.js';

const SUBJECT_WRAPPER_FUNCTIONS = new Set(['channelSubject', 'localSubject']);
const MAX_EXPANDED_OBJECT_FIELDS = 20;

export interface SubjectExtractionOptions {
  /** Named field types to expand in generated subject field docs. */
  subjectFieldTypeExpansions?: readonly string[];
}

/**
 * Describes a single namespace registration call found during source scanning.
 * Consumed by {@link extractSubjects} to resolve subject entries.
 */
export interface RawNamespaceHit {
  prefix: string;
  namespaceConstant: string;
  schemaRecordName: string;
  filePath: string;
  /** How this namespace was registered. */
  kind: NamespaceKind;
  /**
   * When `schemaRecordName` is `'<inline>'`, the actual object literal node
   * that holds the schemas (for subject extraction without re-scanning the file).
   */
  inlineSchemaNode?: ts.ObjectLiteralExpression;
}

/**
 * Metadata extracted from a schema property symbol: its source file and
 * TSDoc description.
 */
interface SymbolMetadata {
  /** Relative path to the file where the schema is declared, if different from the namespace file. */
  schemaFile?: string;
  /** TSDoc description extracted from the schema symbol. */
  description?: string;
}

/**
 * Returns `true` if the call expression is a `registerNamespace` invocation,
 * either as `MakaioBus.registerNamespace(...)` or as a direct import.
 * @param call - The call expression node to inspect.
 * @returns `true` when the callee is `MakaioBus.registerNamespace` or a direct `registerNamespace` call.
 */
export function isRegisterNamespaceCall(call: ts.CallExpression): boolean {
  const expr = call.expression;

  // MakaioBus.registerNamespace(...)
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'MakaioBus' &&
    ts.isIdentifier(expr.name) &&
    expr.name.text === 'registerNamespace'
  ) {
    return true;
  }

  // registerNamespace(...) — direct import
  if (ts.isIdentifier(expr) && expr.text === 'registerNamespace') {
    return true;
  }

  return false;
}

/**
 * Extracts subject entries from the schema record referenced in the
 * registration call.
 *
 * Uses the type checker to resolve the schema record's type and determine
 * each property's shape: a bare Zod schema is classified as an event, while a
 * schema with `request` and `response` properties is classified as an RPC.
 * @param hit - The raw registration hit describing the call location and names.
 * @param program - The TypeScript program used to resolve source files.
 * @param checker - The TypeScript type checker for symbol and type resolution.
 * @param analysisRoot - Absolute path to the analysis root for relative path computation.
 * @param options - Subject extraction options for the active docs surface.
 * @returns Array of subject entries extracted from the schema record.
 */
export function extractSubjects(
  hit: RawNamespaceHit,
  program: ts.Program,
  checker: ts.TypeChecker,
  analysisRoot: string,
  options: SubjectExtractionOptions = {},
): SubjectEntry[] {
  const sourceFile = program.getSourceFile(hit.filePath);
  if (!sourceFile) return [];

  if (hit.schemaRecordName === '<inline>') {
    if (hit.inlineSchemaNode) {
      return extractSubjectsFromObjectLiteral(
        hit.prefix,
        hit.inlineSchemaNode,
        checker,
        hit.filePath,
        analysisRoot,
        options,
      );
    }
    return extractSubjectsFromInlineArg(hit, sourceFile, checker, analysisRoot, options);
  }

  // 1. Exported symbol (e.g. `export const AgentSchemas = { ... }`)
  const exportedSymbol = findExportedSymbol(sourceFile, hit.schemaRecordName, checker);
  if (exportedSymbol)
    return extractSubjectsFromSymbol(hit.prefix, exportedSymbol, checker, hit.filePath, analysisRoot, options);

  // 2. Imported symbol (e.g. `import { FooSchemas } from './schemas.js'`)
  const imported = extractSubjectsFromImport(hit, sourceFile, program, checker, analysisRoot, options);
  if (imported.length > 0) return imported;

  // 3. File-local variable (e.g. `const CredentialSchemas = { ... }`)
  const localSymbol = findLocalSymbol(sourceFile, hit.schemaRecordName, checker);
  if (localSymbol)
    return extractSubjectsFromSymbol(hit.prefix, localSymbol, checker, hit.filePath, analysisRoot, options);

  return [];
}

/**
 * Resolves subjects when the schema record is imported from another file.
 * @param hit - The raw registration hit identifying the schema record name.
 * @param namespaceFile - The source file that contains the registerNamespace call.
 * @param program - The TypeScript program used to resolve imported source files.
 * @param checker - The TypeScript type checker for symbol resolution.
 * @param analysisRoot - Absolute path to the analysis root for relative path computation.
 * @param options - Subject extraction options for the active docs surface.
 * @returns Array of subject entries, or an empty array if the import is not found.
 */
function extractSubjectsFromImport(
  hit: RawNamespaceHit,
  namespaceFile: ts.SourceFile,
  program: ts.Program,
  checker: ts.TypeChecker,
  analysisRoot: string,
  options: SubjectExtractionOptions,
): SubjectEntry[] {
  // The schema is imported from another file. Find the import declaration.
  for (const stmt of namespaceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!stmt.importClause?.namedBindings) continue;
    if (!ts.isNamedImports(stmt.importClause.namedBindings)) continue;

    for (const element of stmt.importClause.namedBindings.elements) {
      const localName = element.name.text;
      if (localName !== hit.schemaRecordName) continue;

      const symbol = checker.getSymbolAtLocation(element.name);
      if (symbol) {
        const aliased = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        return extractSubjectsFromSymbol(hit.prefix, aliased, checker, hit.filePath, analysisRoot, options);
      }
    }
  }

  return [];
}

/**
 * Unwraps a `LocalSubjectSchema` or `ChannelSubjectSchema` wrapper type,
 * returning the inner schema type. Returns the original type unchanged if
 * it is not a wrapper.
 *
 * Wrappers are identified by the presence of a `__local` or `__channel`
 * property combined with a `schema` property.
 * @param type - The TypeScript type to inspect.
 * @param checker - The TypeScript type checker for property resolution.
 * @returns The unwrapped base schema type, or the original type if not wrapped.
 */
function unwrapSubjectSchema(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  const hasLocalFlag = type.getProperty('__local') !== undefined;
  const hasChannelFlag = type.getProperty('__channel') !== undefined;

  if (!hasLocalFlag && !hasChannelFlag) return type;

  const schemaProp = type.getProperty('schema');
  if (!schemaProp) return type;

  return checker.getTypeOfSymbol(schemaProp);
}

/**
 * Extracts typed fields from a Zod schema type via its `_output` property.
 *
 * The `_output` property on a ZodObject type resolves to the TypeScript type
 * the schema validates to, giving us the exact field names, types, and
 * optionality without executing the schema at runtime.
 * @param checker - The TypeScript type checker for property and type resolution.
 * @param zodType - The Zod schema type to introspect.
 * @param options - Field rendering options for the active docs surface.
 * @returns Sorted array of field descriptors, an empty array for an empty object schema, or `undefined` when extraction does not apply.
 */
function extractFieldsFromZodType(
  checker: ts.TypeChecker,
  zodType: ts.Type,
  options: SubjectExtractionOptions,
): SubjectField[] | undefined {
  const outputProp = zodType.getProperty('_output');
  if (!outputProp) return undefined;

  const outputType = checker.getTypeOfSymbol(outputProp);
  const fields: SubjectField[] = [];

  for (const field of outputType.getProperties()) {
    const fieldType = checker.getTypeOfSymbol(field);
    const typeString = formatSubjectFieldType(checker, fieldType, options);
    const isOptional = !!(field.flags & ts.SymbolFlags.Optional);
    fields.push({ name: field.getName(), type: typeString, required: !isOptional });
  }

  fields.sort((a, b) => a.name.localeCompare(b.name));
  return fields.length > 0 || zodType.getProperty('shape') ? fields : undefined;
}

/**
 * Formats a subject field type for docs, expanding top-level named object
 * aliases so generated pages remain self-contained.
 * @param checker - Type checker used to inspect field types.
 * @param type - Field type to render.
 * @param options - Field rendering options for the active docs surface.
 * @param depth - Current expansion depth; nested named types stay named.
 * @returns Human-readable TypeScript type string.
 */
function formatSubjectFieldType(
  checker: ts.TypeChecker,
  type: ts.Type,
  options: SubjectExtractionOptions,
  depth = 0,
): string {
  const rendered = renderType(checker, type);
  const expandedTypes = new Set(options.subjectFieldTypeExpansions ?? []);

  if (type.isUnion()) {
    // Union and array wrappers do not increase depth so top-level fields like
    // `ContextRule | null` and `ContextRule[]` can still expand the named
    // object once; nested object properties increment depth below.
    const containsExpandedType = type.types.some((part) => expandedTypes.has(renderType(checker, part)));
    if (!containsExpandedType) return rendered;
    return type.types.map((part) => formatSubjectFieldType(checker, part, options, depth)).join(' | ');
  }

  if (checker.isArrayType(type)) {
    const elementType = (type as ts.TypeReference).typeArguments?.[0];
    if (!elementType || !expandedTypes.has(renderType(checker, elementType))) return rendered;
    return `${formatSubjectFieldType(checker, elementType, options, depth)}[]`;
  }

  const shouldExpand =
    depth === 0 &&
    expandedTypes.has(rendered) &&
    type.getProperties().length > 0 &&
    type.getProperties().length <= MAX_EXPANDED_OBJECT_FIELDS;
  if (!shouldExpand) return rendered;

  const fields = type.getProperties().map((prop) => {
    const optional = prop.flags & ts.SymbolFlags.Optional ? '?' : '';
    const propType = formatSubjectFieldType(checker, checker.getTypeOfSymbol(prop), options, depth + 1);
    return `${prop.getName()}${optional}: ${propType}`;
  });
  return `{ ${fields.join('; ')}; }`;
}

/**
 * Renders a TypeScript type without truncating long object shapes.
 * @param checker - Type checker used to stringify the type.
 * @param type - Type to render.
 * @returns TypeScript type string.
 */
function renderType(checker: ts.TypeChecker, type: ts.Type): string {
  return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
}

/**
 * Extracts the source file path and TSDoc description from a schema property symbol.
 * @param prop - The TypeScript symbol for the schema record property.
 * @param checker - The TypeScript type checker for documentation extraction.
 * @param namespaceFilePath - Absolute path of the namespace file (to suppress when identical).
 * @param analysisRoot - Absolute analysis root for relative path computation.
 * @returns Metadata object with optional `schemaFile` and `description` fields.
 */
function extractSymbolMetadata(
  prop: ts.Symbol,
  checker: ts.TypeChecker,
  namespaceFilePath: string,
  analysisRoot: string,
): SymbolMetadata {
  const result: SymbolMetadata = {};

  // Follow the property initializer to resolve the actual schema definition.
  // Given `{ startAgent: StartAgentSchema }`, we want the declaration of
  // `StartAgentSchema`, not the property assignment itself.
  const originSymbol = resolvePropertyOrigin(prop, checker);
  const decl = originSymbol.getDeclarations()?.[0];
  if (decl) {
    const declFile = decl.getSourceFile().fileName;
    if (declFile !== namespaceFilePath) {
      result.schemaFile = relativeInventoryPath(analysisRoot, declFile);
    }
  }

  const docs = prop.getDocumentationComment(checker);
  if (docs.length > 0) {
    const text = docs
      .map((d) => d.text)
      .join('')
      .trim();
    if (text) result.description = text;
    return result;
  }

  const originDocs = originSymbol.getDocumentationComment(checker);
  if (originDocs.length > 0) {
    const text = originDocs
      .map((d) => d.text)
      .join('')
      .trim();
    if (text) result.description = text;
  }

  return result;
}

/**
 * Resolves a schema record property to its original definition symbol.
 *
 * For `{ startAgent: StartAgentSchema }`, the property symbol points at the
 * assignment in the barrel file. This function follows the initializer
 * identifier through import aliases to find where the schema is actually
 * declared (e.g. `schemas/start-agent.ts`).
 * @param prop - The property symbol from the schema record type.
 * @param checker - The TypeScript type checker for symbol resolution.
 * @returns The resolved origin symbol, or the original property symbol as fallback.
 */
function resolvePropertyOrigin(prop: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  const decl = prop.getDeclarations()?.[0];
  if (!decl) return prop;

  // PropertyAssignment: `{ key: SomeIdentifier }` or `{ key: localSubject(SomeIdentifier) }`
  if (ts.isPropertyAssignment(decl)) {
    const originIdentifier = getSchemaOriginIdentifier(decl.initializer);
    const initSymbol = originIdentifier ? checker.getSymbolAtLocation(originIdentifier) : undefined;
    if (initSymbol) {
      const aliased = initSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(initSymbol) : initSymbol;
      return aliased;
    }
  }

  // ShorthandPropertyAssignment: `{ SomeSchema }` — shorthand resolves through alias
  if (ts.isShorthandPropertyAssignment(decl)) {
    const shorthandSymbol = checker.getShorthandAssignmentValueSymbol(decl);
    if (shorthandSymbol) {
      const aliased =
        shorthandSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(shorthandSymbol) : shorthandSymbol;
      return aliased;
    }
  }

  // Fallback: resolve the property itself through aliases
  return prop.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(prop) : prop;
}

/**
 * Finds the schema identifier in a schema-record property initializer.
 * @param initializer - The property initializer to inspect.
 * @returns The referenced schema identifier, or `undefined` when unsupported.
 */
function getSchemaOriginIdentifier(initializer: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(initializer)) return initializer;

  if (!ts.isCallExpression(initializer)) return undefined;
  if (!ts.isIdentifier(initializer.expression)) return undefined;
  if (!SUBJECT_WRAPPER_FUNCTIONS.has(initializer.expression.text)) return undefined;

  const [firstArg] = initializer.arguments;
  return firstArg && ts.isIdentifier(firstArg) ? firstArg : undefined;
}

/**
 * Builds a `SubjectEntry` from a resolved base schema type (after unwrapping
 * any local/channel wrapper). Handles both event schemas (bare Zod type) and
 * RPC schemas (`{ request, response }`).
 * @param key - The schema record property key, e.g. `'tool.use'`.
 * @param prefix - The namespace prefix string, e.g. `'agent'`.
 * @param baseType - The unwrapped TypeScript type for the schema.
 * @param checker - The TypeScript type checker for property and type resolution.
 * @param prop - The TypeScript symbol for the schema record property.
 * @param namespaceFilePath - Absolute path of the namespace file.
 * @param analysisRoot - Absolute analysis root for relative path computation.
 * @param options - Subject extraction options for the active docs surface.
 * @returns A fully-populated `SubjectEntry`.
 */
function buildSubjectEntry(
  key: string,
  prefix: string,
  baseType: ts.Type,
  checker: ts.TypeChecker,
  prop: ts.Symbol,
  namespaceFilePath: string,
  analysisRoot: string,
  options: SubjectExtractionOptions,
): SubjectEntry {
  const wire = `${prefix}.${key}`;
  const { schemaFile, description } = extractSymbolMetadata(prop, checker, namespaceFilePath, analysisRoot);
  const requestProp = baseType.getProperty('request');
  const responseProp = baseType.getProperty('response');
  const isRpc = requestProp !== undefined && responseProp !== undefined;

  if (isRpc) {
    const requestType = checker.getTypeOfSymbol(requestProp);
    const responseType = checker.getTypeOfSymbol(responseProp);
    return {
      key,
      wire,
      type: 'rpc',
      schemaFile,
      description,
      request: extractFieldsFromZodType(checker, requestType, options),
      response: extractFieldsFromZodType(checker, responseType, options),
    };
  }

  return {
    key,
    wire,
    type: 'event',
    schemaFile,
    description,
    payload: extractFieldsFromZodType(checker, baseType, options),
  };
}

/**
 * Extracts subject entries by inspecting the properties of the given symbol's type.
 * @param prefix - The namespace prefix string used to build the full wire subject.
 * @param symbol - The TypeScript symbol for the schema record object.
 * @param checker - The TypeScript type checker for property resolution.
 * @param namespaceFilePath - Absolute path of the namespace file.
 * @param analysisRoot - Absolute analysis root for relative path computation.
 * @param options - Subject extraction options for the active docs surface.
 * @returns Array of subject entries sorted by key.
 */
function extractSubjectsFromSymbol(
  prefix: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  namespaceFilePath: string,
  analysisRoot: string,
  options: SubjectExtractionOptions,
): SubjectEntry[] {
  const type = checker.getTypeOfSymbol(symbol);
  const subjects: SubjectEntry[] = [];

  for (const prop of type.getProperties()) {
    const key = prop.getName();
    const propType = checker.getTypeOfSymbol(prop);
    const baseType = unwrapSubjectSchema(propType, checker);
    subjects.push(buildSubjectEntry(key, prefix, baseType, checker, prop, namespaceFilePath, analysisRoot, options));
  }

  subjects.sort((a, b) => a.key.localeCompare(b.key));
  return subjects;
}

/**
 * Finds a module-exported symbol by name using the type checker's exports list.
 * @param sourceFile - The TypeScript source file whose exports to inspect.
 * @param name - The exported symbol name to find.
 * @param checker - The TypeScript type checker for module export resolution.
 * @returns The matching exported symbol, or `undefined` if not found.
 */
function findExportedSymbol(sourceFile: ts.SourceFile, name: string, checker: ts.TypeChecker): ts.Symbol | undefined {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return undefined;

  const exports = checker.getExportsOfModule(moduleSymbol);
  return exports.find((s) => s.getName() === name);
}

/**
 * Finds a file-local (non-exported) variable by walking all statements.
 * Handles `const FooSchemas = { ... }` without an export modifier.
 * @param sourceFile - The TypeScript source file to search.
 * @param name - The variable name to look up.
 * @param checker - The TypeScript type checker used to resolve the symbol.
 * @returns The TypeScript symbol for the variable, or `undefined` if not found.
 */
function findLocalSymbol(sourceFile: ts.SourceFile, name: string, checker: ts.TypeChecker): ts.Symbol | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) {
        return checker.getSymbolAtLocation(decl.name);
      }
    }
  }

  return undefined;
}

/**
 * Extracts subjects from an already-resolved inline object literal node.
 *
 * Used when the schema node was captured at scan time (factory calls), avoiding
 * the need to re-walk the source file.
 * @param prefix - The namespace prefix for building wire subjects.
 * @param node - The inline object literal expression holding the schemas.
 * @param checker - The TypeScript type checker for type resolution.
 * @param namespaceFilePath - Absolute path of the namespace file.
 * @param analysisRoot - Absolute analysis root for relative path computation.
 * @param options - Subject extraction options for the active docs surface.
 * @returns Array of subject entries sorted by key.
 */
function extractSubjectsFromObjectLiteral(
  prefix: string,
  node: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  namespaceFilePath: string,
  analysisRoot: string,
  options: SubjectExtractionOptions,
): SubjectEntry[] {
  const type = checker.getTypeAtLocation(node);
  const subjects: SubjectEntry[] = [];

  for (const prop of type.getProperties()) {
    const key = prop.getName();
    const propType = checker.getTypeOfSymbol(prop);
    const baseType = unwrapSubjectSchema(propType, checker);
    subjects.push(buildSubjectEntry(key, prefix, baseType, checker, prop, namespaceFilePath, analysisRoot, options));
  }

  subjects.sort((a, b) => a.key.localeCompare(b.key));
  return subjects;
}

/**
 * Extracts subjects when the schema record is an inline object literal
 * passed directly to registerNamespace() (fallback for direct-call hits without
 * a stored inline node).
 * @param hit - The raw registration hit describing the call location.
 * @param sourceFile - The source file containing the inline registerNamespace call.
 * @param checker - The TypeScript type checker for type resolution.
 * @param analysisRoot - Absolute analysis root for relative path computation.
 * @param options - Subject extraction options for the active docs surface.
 * @returns Array of subject entries sorted by key, or empty if not found.
 */
function extractSubjectsFromInlineArg(
  hit: RawNamespaceHit,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  analysisRoot: string,
  options: SubjectExtractionOptions,
): SubjectEntry[] {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
      if (!isRegisterNamespaceCall(decl.initializer)) continue;

      const prefixArg = decl.initializer.arguments[0];
      if (!prefixArg) continue;
      if (!ts.isStringLiteral(prefixArg) && !ts.isNoSubstitutionTemplateLiteral(prefixArg)) continue;
      if (prefixArg.text !== hit.prefix) continue;

      const schemasArg = decl.initializer.arguments[1];
      if (schemasArg && ts.isObjectLiteralExpression(schemasArg)) {
        return extractSubjectsFromObjectLiteral(hit.prefix, schemasArg, checker, hit.filePath, analysisRoot, options);
      }
    }
  }

  return [];
}

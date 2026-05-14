import * as ts from 'typescript';

import { matchesInventoryPathPrefix, relativeInventoryPath } from './path-utils.js';
import { classifyTier, resolvePackageName } from './program.js';
import type { NamespaceEntry, NamespaceKind, NamespaceTier } from './types.js';
import { extractSubjects, isRegisterNamespaceCall, type RawNamespaceHit } from './extract-subjects.js';

/** Options controlling namespace extraction from a TypeScript program. */
export interface NamespaceExtractionOptions {
  /** POSIX path prefixes, relative to the analysis root, to skip during extraction. */
  excludePathPrefixes?: readonly string[];
  /** Named field types to expand in generated subject field docs. */
  subjectFieldTypeExpansions?: readonly string[];
  /** Host policy that classifies namespace definition paths for documentation tiers. */
  classifyNamespaceTier?: (relativePath: string, analysisRoot: string) => NamespaceTier;
}

/**
 * Specification for a namespace factory function.
 *
 * Each factory wraps `MakaioBus.registerNamespace` with a domain transformation
 * and optional config-object wrapping of the schemas argument.
 */
interface FactorySpec {
  /**
   * Template for the full bus prefix.
   * The substring `{name}` is replaced with the first string argument value.
   * If the first argument already contains the full prefix (no transformation
   * needed), use `'{name}'` directly.
   */
  prefixTemplate: string;
  /** Zero-based index of the argument that carries the schemas (or config object). */
  schemasArgIndex: number;
  /**
   * When `true`, the schemas arg is an object literal with a `schemas` property
   * (e.g. `createStorageNamespace(domain, { schemas: {...} })`).
   * When `false`, the schemas arg IS the schema record directly.
   */
  schemasInConfig: boolean;
  /** The kind value written into the output `NamespaceEntry`. */
  kind: NamespaceKind;
}

/**
 * Registry mapping each factory function name to its prefix and schema strategy.
 *
 * `createAdapterNamespace` passes the domain as-is (no prefix added) — callers
 * already supply the full domain string (e.g. `'adapter:gemini'`).
 */
const FACTORY_REGISTRY: Record<string, FactorySpec> = {
  createStorageNamespace: {
    prefixTemplate: 'storage:{name}',
    schemasArgIndex: 1,
    schemasInConfig: true,
    kind: 'storage',
  },
  createAdapterNamespace: {
    prefixTemplate: '{name}',
    schemasArgIndex: 1,
    schemasInConfig: false,
    kind: 'adapter',
  },
  createClientNamespace: {
    prefixTemplate: 'client:{name}',
    schemasArgIndex: 1,
    schemasInConfig: false,
    kind: 'client',
  },
  createExtensionNamespace: {
    prefixTemplate: 'extension:{name}',
    schemasArgIndex: 1,
    schemasInConfig: true,
    kind: 'extension',
  },
  createExtensionStorageNamespace: {
    prefixTemplate: 'storage:extension:{name}',
    schemasArgIndex: 1,
    schemasInConfig: true,
    kind: 'extension-storage',
  },
};

/**
 * Scans all source files for namespace registration calls — both direct
 * `MakaioBus.registerNamespace()` and the factory wrappers listed in
 * {@link FACTORY_REGISTRY} — and extracts namespace metadata.
 * @param program - The TypeScript program covering the analysis workspace.
 * @param analysisRoot - Absolute path to the analysis root directory.
 * @param options - Optional extraction filters.
 * @returns Array of fully-populated namespace entries.
 */
export function extractNamespaces(
  program: ts.Program,
  analysisRoot: string,
  options: NamespaceExtractionOptions = {},
): NamespaceEntry[] {
  const checker = program.getTypeChecker();
  const hits: RawNamespaceHit[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes('node_modules')) continue;
    if (sourceFile.fileName.includes('__tests__')) continue;
    if (sourceFile.fileName.includes('.test.')) continue;
    if (matchesInventoryPathPrefix(analysisRoot, sourceFile.fileName, options.excludePathPrefixes)) continue;

    findRegisterCalls(sourceFile, checker, hits);
  }

  console.error(`Found ${hits.length} namespace registration calls`);

  const entries: NamespaceEntry[] = [];

  for (const hit of hits) {
    const subjects = extractSubjects(hit, program, checker, analysisRoot, {
      subjectFieldTypeExpansions: options.subjectFieldTypeExpansions,
    });
    const subjectsConstant = findSubjectsExport(hit, program);

    entries.push({
      prefix: hit.prefix,
      namespaceConstant: hit.namespaceConstant,
      subjectsConstant,
      schemaRecordName: hit.schemaRecordName,
      kind: hit.kind,
      tier: classifyTier(hit.filePath, analysisRoot, options.classifyNamespaceTier),
      definedIn: {
        file: relativeInventoryPath(analysisRoot, hit.filePath),
        package: resolvePackageName(hit.filePath),
      },
      subjects,
      callsites: { framework: [], host: [] },
    });
  }

  return entries;
}

/**
 * Walks a source file's AST looking for both direct `registerNamespace` calls
 * and factory function calls registered in {@link FACTORY_REGISTRY}.
 *
 * Handles:
 * - `export const FooNamespace = MakaioBus.registerNamespace('foo', FooSchemas);`
 * - `export const FooNamespace = createStorageNamespace('foo', { schemas: ... });`
 * - `const { subjects } = createClientNamespace('codex', schemas);`
 * - Destructuring patterns for `createClientNamespace`
 * @param sourceFile - The TypeScript source file to walk.
 * @param checker - The TypeScript type checker for variable resolution.
 * @param hits - Accumulator array to append discovered registration hits to.
 */
function findRegisterCalls(sourceFile: ts.SourceFile, checker: ts.TypeChecker, hits: RawNamespaceHit[]): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (!ts.isCallExpression(decl.initializer)) continue;

      const call = decl.initializer;

      // Direct registerNamespace call
      if (isRegisterNamespaceCall(call)) {
        const hit = extractDirectRegisterHit(call, decl, sourceFile);
        if (hit) hits.push(hit);
        continue;
      }

      // Factory function calls
      const factoryName = getCallName(call);
      if (!factoryName) continue;
      const spec = FACTORY_REGISTRY[factoryName];
      if (!spec) continue;

      const hit = extractFactoryHit(call, decl, spec, checker, sourceFile);
      if (hit) hits.push(hit);
    }
  }
}

/**
 * Extracts a `RawNamespaceHit` from a direct `registerNamespace(prefix, schemas)` call.
 * @param call - The call expression node.
 * @param decl - The variable declarator containing the call.
 * @param sourceFile - The source file being analyzed.
 * @returns The hit, or `undefined` if arguments are missing or malformed.
 */
function extractDirectRegisterHit(
  call: ts.CallExpression,
  decl: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
): RawNamespaceHit | undefined {
  const [prefixArg, schemasArg] = call.arguments;
  if (!prefixArg || !ts.isStringLiteral(prefixArg)) return undefined;

  const namespaceConstant = ts.isIdentifier(decl.name) ? decl.name.text : '<unknown>';
  const isInline = schemasArg !== undefined && ts.isObjectLiteralExpression(schemasArg);
  const schemaRecordName =
    schemasArg && ts.isIdentifier(schemasArg) ? schemasArg.text : isInline ? '<inline>' : '<unknown>';

  return {
    prefix: prefixArg.text,
    namespaceConstant,
    schemaRecordName,
    filePath: sourceFile.fileName,
    kind: 'bus',
    inlineSchemaNode: isInline ? (schemasArg as ts.ObjectLiteralExpression) : undefined,
  };
}

/**
 * Extracts a `RawNamespaceHit` from a factory function call (e.g.
 * `createStorageNamespace`, `createAdapterNamespace`, etc.).
 *
 * Resolves the domain string (including variable references) and locates the
 * schema record argument, unwrapping it from a config object when the factory
 * spec requires it (`schemasInConfig: true`).
 * @param call - The factory call expression.
 * @param decl - The variable declarator containing the call.
 * @param spec - The factory specification from {@link FACTORY_REGISTRY}.
 * @param checker - The TypeScript type checker used for variable resolution.
 * @param sourceFile - The source file being analyzed.
 * @returns The hit, or `undefined` if the domain string cannot be resolved.
 */
function extractFactoryHit(
  call: ts.CallExpression,
  decl: ts.VariableDeclaration,
  spec: FactorySpec,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): RawNamespaceHit | undefined {
  const [domainArg] = call.arguments;
  if (!domainArg) return undefined;

  const domainName = resolveStringArg(domainArg, checker);
  if (!domainName) return undefined;

  const prefix = spec.prefixTemplate.replace('{name}', domainName);

  // Derive the constant name from the LHS binding.
  // For destructuring (e.g. `const { subjects } = createClientNamespace(...)`)
  // we fall back to the resolved domain string as the namespace constant.
  const namespaceConstant = ts.isIdentifier(decl.name) ? decl.name.text : domainName;

  const schemasArgNode = call.arguments[spec.schemasArgIndex];
  const { name: schemaRecordName, node: inlineSchemaNode } = resolveSchemaRecord(schemasArgNode, spec.schemasInConfig);

  return {
    prefix,
    namespaceConstant,
    schemaRecordName,
    filePath: sourceFile.fileName,
    kind: spec.kind,
    inlineSchemaNode,
  };
}

/** Result of resolving a factory's schema record argument. */
interface SchemaRecordResult {
  /** The variable name, `'<inline>'`, or `'<unknown>'`. */
  name: string;
  /** The inline object literal node when `name` is `'<inline>'`, else `undefined`. */
  node?: ts.ObjectLiteralExpression;
}

/**
 * Resolves the schema record from the schemas argument of a factory call.
 *
 * When `schemasInConfig` is `true`, the argument is an object literal whose
 * `schemas` property holds the actual record (e.g.
 * `createStorageNamespace(domain, { schemas: FooSchemas })`).
 * Otherwise the argument itself is the schema record.
 * @param schemasArgNode - The argument node at the schemas position (may be `undefined`).
 * @param schemasInConfig - Whether schemas are nested in a `schemas` property.
 * @returns The schema record name and optional inline node.
 */
function resolveSchemaRecord(schemasArgNode: ts.Expression | undefined, schemasInConfig: boolean): SchemaRecordResult {
  if (!schemasArgNode) return { name: '<unknown>' };

  if (!schemasInConfig) {
    if (ts.isIdentifier(schemasArgNode)) return { name: schemasArgNode.text };
    if (ts.isObjectLiteralExpression(schemasArgNode)) return { name: '<inline>', node: schemasArgNode };
    return { name: '<unknown>' };
  }

  // Config-wrapped: find the `schemas` property inside an object literal
  if (!ts.isObjectLiteralExpression(schemasArgNode)) return { name: '<unknown>' };

  for (const prop of schemasArgNode.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'schemas') {
      return { name: prop.name.text };
    }

    if (!ts.isPropertyAssignment(prop)) continue;

    const propName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (propName !== 'schemas') continue;

    if (ts.isIdentifier(prop.initializer)) return { name: prop.initializer.text };
    if (ts.isObjectLiteralExpression(prop.initializer)) return { name: '<inline>', node: prop.initializer };
    return { name: '<unknown>' };
  }

  return { name: '<unknown>' };
}

/**
 * Extracts the callee name from a call expression (simple identifier or
 * property access), returning `undefined` for complex expressions.
 * @param call - The call expression to inspect.
 * @returns The function name string, or `undefined` if not extractable.
 */
function getCallName(call: ts.CallExpression): string | undefined {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return undefined;
}

/**
 * Resolves a call argument to its string value.
 *
 * Handles:
 * - String literal: returns the text directly.
 * - Template literal (no substitutions): returns the template span text.
 * - Identifier: uses the type checker to resolve the string literal type of
 *   the referenced symbol.
 * @param arg - The call argument expression to resolve.
 * @param checker - The TypeScript type checker for identifier resolution.
 * @returns The resolved string, or `undefined` if resolution fails.
 */
function resolveStringArg(arg: ts.Expression, checker: ts.TypeChecker): string | undefined {
  if (ts.isStringLiteral(arg)) return arg.text;

  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;

  if (ts.isIdentifier(arg)) {
    const type = checker.getTypeAtLocation(arg);
    if (type.isStringLiteral()) return type.value;
  }

  return undefined;
}

/**
 * Finds the `XxxSubjects` export in the same file as the namespace registration.
 * Pattern: `export const AgentSubjects = AgentNamespace.subjects;`
 * @param hit - The raw registration hit whose namespace constant to match.
 * @param program - The TypeScript program used to retrieve the source file.
 * @returns The subjects constant name (e.g. `'AgentSubjects'`), or `null` if absent.
 */
function findSubjectsExport(hit: RawNamespaceHit, program: ts.Program): string | null {
  const sourceFile = program.getSourceFile(hit.filePath);
  if (!sourceFile) return null;

  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (!ts.isPropertyAccessExpression(decl.initializer)) continue;

      const propAccess = decl.initializer;
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === hit.namespaceConstant &&
        propAccess.name.text === 'subjects' &&
        ts.isIdentifier(decl.name)
      ) {
        return decl.name.text;
      }
    }
  }

  return null;
}

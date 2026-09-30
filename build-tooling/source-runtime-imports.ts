import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Parse TypeScript source text. Parent pointers are always set so results never
 * depend on that flag.
 * @param sourceText - TypeScript source text.
 * @param fileName - File name used for diagnostics.
 * @returns Parsed source file.
 */
function parse(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Collect the module specifiers a TypeScript source file loads at runtime from
 * its top-level declarations: value imports, side-effect imports,
 * `import x = require()`, `export … from`, and `export * from`. Type-only
 * declarations (`import type`, `export type … from`, `import type x = require()`)
 * and declarations whose named specifiers are all `type`-qualified are skipped
 * because the compiler erases them. Dynamic `import()` calls are not collected;
 * see {@link hasDynamicImportCall}.
 * @param sourceText - TypeScript source text.
 * @param fileName - File name used for diagnostics.
 * @returns Sorted, de-duplicated runtime module specifiers.
 */
export function collectRuntimeImports(sourceText: string, fileName: string): string[] {
  const specifiers = new Set<string>();

  for (const statement of parse(sourceText, fileName).statements) {
    const specifier = runtimeSpecifierOf(statement);
    if (specifier !== undefined) specifiers.add(specifier);
  }

  return [...specifiers].sort();
}

/**
 * Resolve the runtime module specifier of one top-level statement.
 * @param statement - Top-level statement.
 * @returns The specifier, or `undefined` when the statement loads nothing at runtime.
 */
function runtimeSpecifierOf(statement: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(statement)) {
    return ts.isStringLiteral(statement.moduleSpecifier) && !isTypeOnlyImport(statement.importClause)
      ? statement.moduleSpecifier.text
      : undefined;
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    const reference = statement.moduleReference;
    return !statement.isTypeOnly && ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)
      ? reference.expression.text
      : undefined;
  }
  if (ts.isExportDeclaration(statement)) {
    return statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !isTypeOnlyExport(statement)
      ? statement.moduleSpecifier.text
      : undefined;
  }
  return undefined;
}

/**
 * Check whether an import clause is erased by the compiler.
 * @param clause - Import clause, absent for side-effect imports.
 * @returns True for `import type` and all-`type`-qualified named bindings.
 */
function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

/**
 * Check whether a re-export declaration is erased by the compiler.
 * @param statement - Export declaration with a module specifier.
 * @returns True for `export type … from` and all-`type`-qualified named exports.
 */
function isTypeOnlyExport(statement: ts.ExportDeclaration): boolean {
  const clause = statement.exportClause;
  return (
    statement.isTypeOnly ||
    (clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly))
  );
}

/**
 * Check whether a source contains any dynamic `import(...)` call expression.
 * Comments and string literals are ignored because the check walks the AST.
 * @param sourceText - TypeScript source text.
 * @param fileName - File name used for diagnostics.
 * @returns True when a dynamic import call exists anywhere in the source.
 */
export function hasDynamicImportCall(sourceText: string, fileName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(sourceText, fileName));
  return found;
}

/**
 * Read and JSON-parse a package manifest.
 * @param path - Path to the `package.json` file.
 * @returns Parsed manifest.
 */
export function readManifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

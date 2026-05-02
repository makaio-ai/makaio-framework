/**
 * Cross-package reference analysis using the TS Compiler API.
 *
 * Builds a full workspace TS program, scans all import declarations for
 * a barrel's package specifier, and collects imported symbol names.
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

import type { DeadExportSet } from './types.js';
import {
  collectSubpathSpecifiers,
  createPackageSpecifierMatcher,
  findWorkspaceRoot,
  findPackageDir,
} from './ts-program.js';

/**
 * Scans the entire workspace for external consumers of the barrel's package.
 * Returns a {@link DeadExportSet} where `values` contains the set of
 * externally consumed symbol names (to be inverted by `invertToDeadSet`).
 * @param barrelAbsPath - Absolute path to the barrel file.
 */
export async function findExternalConsumers(barrelAbsPath: string): Promise<DeadExportSet> {
  console.error('Scanning for external consumers (TS Compiler API)...');

  const packageDir = findPackageDir(barrelAbsPath);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'));
  const packageName: string = packageJson.name;

  const subpathSpecifiers = collectSubpathSpecifiers(packageJson, packageName);

  console.error(`  Package: ${packageName}`);
  console.error(`  Subpaths: ${subpathSpecifiers.length > 0 ? subpathSpecifiers.join(', ') : '(none)'}`);

  const workspaceRoot = findWorkspaceRoot(barrelAbsPath);
  const tsConfigPath = path.join(workspaceRoot, 'tsconfig.json');
  if (!fs.existsSync(tsConfigPath)) {
    throw new Error(`No tsconfig.json found at workspace root: ${workspaceRoot}`);
  }

  console.error(`  Loading workspace TypeScript program from ${path.relative(process.cwd(), tsConfigPath)}...`);
  const { config } = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, workspaceRoot);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });

  const sourceFiles = program.getSourceFiles();
  console.error(`  Program has ${sourceFiles.length} source files`);

  const externallyImported = new Set<string>();
  const barrelDirNormalized = path.normalize(packageDir) + path.sep;

  let filesScanned = 0;
  let importsFound = 0;

  const isTargetSpecifier = createPackageSpecifierMatcher([packageName, ...subpathSpecifiers]);

  for (const sourceFile of sourceFiles) {
    const normalizedPath = path.normalize(sourceFile.fileName);
    if (normalizedPath.startsWith(barrelDirNormalized)) continue;
    if (normalizedPath.includes('node_modules') || normalizedPath.includes(`${path.sep}dist${path.sep}`)) continue;

    filesScanned++;

    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier) {
        const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (isTargetSpecifier(specifier)) {
          collectImportedNames(stmt, externallyImported);
          importsFound++;
        }
      }

      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
        const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (isTargetSpecifier(specifier)) {
          collectReExportedNames(stmt, externallyImported);
          importsFound++;
        }
      }
    }

    collectInlineTypeImports(sourceFile, isTargetSpecifier, externallyImported);
    collectModuleAugmentations(sourceFile, isTargetSpecifier, externallyImported);
  }

  console.error(`  Scanned ${filesScanned} external files, found ${importsFound} import statements`);
  console.error(`  Externally consumed symbols: ${externallyImported.size}`);

  return { values: externallyImported, types: new Set() };
}

/**
 * Collects named imports from an import declaration.
 * @param stmt - The import declaration.
 * @param into - Set to add imported symbol names to.
 */
function collectImportedNames(stmt: ts.ImportDeclaration, into: Set<string>): void {
  const clause = stmt.importClause;
  if (!clause) return;

  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    into.add('*');
    return;
  }

  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      const name = element.propertyName?.text ?? element.name.text;
      into.add(name);
    }
  }

  if (clause.name) {
    into.add('default');
  }
}

/**
 * Collects names from re-export declarations.
 * @param stmt - The export declaration.
 * @param into - Set to add re-exported symbol names to.
 */
function collectReExportedNames(stmt: ts.ExportDeclaration, into: Set<string>): void {
  if (!stmt.exportClause) {
    into.add('*');
    return;
  }

  if (ts.isNamedExports(stmt.exportClause)) {
    for (const element of stmt.exportClause.elements) {
      const name = element.propertyName?.text ?? element.name.text;
      into.add(name);
    }
  }
}

/**
 * Walks the AST looking for `import('specifier').SymbolName` patterns
 * (inline type imports / dynamic import type references).
 * @param sourceFile - The source file to scan.
 * @param isTargetSpecifier - Predicate that matches package root/subpath specifiers.
 * @param into - Set to add discovered symbol names to.
 */
function collectInlineTypeImports(
  sourceFile: ts.SourceFile,
  isTargetSpecifier: (specifier: string) => boolean,
  into: Set<string>,
): void {
  /**
   *
   * @param node
   */
  function visit(node: ts.Node): void {
    if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
        const specifier = arg.literal.text;
        if (isTargetSpecifier(specifier)) {
          if (node.qualifier && ts.isIdentifier(node.qualifier)) {
            into.add(node.qualifier.text);
          } else if (node.qualifier && ts.isQualifiedName(node.qualifier)) {
            let left: ts.EntityName = node.qualifier;
            while (ts.isQualifiedName(left)) left = left.left;
            into.add(left.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
}

/**
 * Scans for `declare module '@pkg' { interface X { ... } }` augmentation blocks.
 * The augmented interface names must remain exported for TS declaration merging to work.
 * @param sourceFile - The source file to scan.
 * @param isTargetSpecifier - Predicate that matches package root/subpath specifiers.
 * @param into - Set to add discovered symbol names to.
 */
function collectModuleAugmentations(
  sourceFile: ts.SourceFile,
  isTargetSpecifier: (specifier: string) => boolean,
  into: Set<string>,
): void {
  for (const stmt of sourceFile.statements) {
    if (
      ts.isModuleDeclaration(stmt) &&
      ts.isStringLiteral(stmt.name) &&
      isTargetSpecifier(stmt.name.text) &&
      stmt.body &&
      ts.isModuleBlock(stmt.body)
    ) {
      for (const inner of stmt.body.statements) {
        if (ts.isInterfaceDeclaration(inner)) {
          into.add(inner.name.text);
        }
        if (ts.isTypeAliasDeclaration(inner)) {
          into.add(inner.name.text);
        }
      }
    }
  }
}

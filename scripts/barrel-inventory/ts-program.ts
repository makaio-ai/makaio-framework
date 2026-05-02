import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

import type { SymbolKind } from './types.js';

const VALUE_FLAGS =
  ts.SymbolFlags.Variable |
  ts.SymbolFlags.Function |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Enum |
  ts.SymbolFlags.ValueModule |
  ts.SymbolFlags.BlockScopedVariable |
  ts.SymbolFlags.FunctionScopedVariable;

const TYPE_FLAGS = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.TypeLiteral;

/**
 * Creates a TS program rooted at the nearest tsconfig.json above the given file.
 * @param barrelAbsPath - Absolute path to a source file.
 */
export function createProgramForBarrel(barrelAbsPath: string): ts.Program {
  const tsConfigPath = findTsConfig(barrelAbsPath);
  if (!tsConfigPath) {
    throw new Error(`No tsconfig.json found for ${barrelAbsPath}`);
  }

  const { config } = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(tsConfigPath));

  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
}

/**
 * Walks up the directory tree to find the nearest tsconfig.json.
 * @param filePath - Starting file path.
 */
function findTsConfig(filePath: string): string | null {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Classifies a TS symbol as value-only, type-only, or both.
 * @param symbol - The TS symbol to classify.
 */
function classifySymbol(symbol: ts.Symbol): SymbolKind {
  const flags = symbol.flags;

  if (flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) {
    return 'both';
  }

  const isValue = Boolean(flags & VALUE_FLAGS);
  const isType = Boolean(flags & TYPE_FLAGS);

  if (isValue && isType) return 'both';
  if (isValue) return 'value';
  if (isType) return 'type';

  if (flags & ts.SymbolFlags.Alias) {
    return 'both';
  }

  if (flags & ts.SymbolFlags.NamespaceModule) {
    return 'value';
  }

  return 'both';
}

/**
 * Classifies an exported symbol, resolving through aliases.
 * @param symbol - The exported TS symbol.
 * @param checker - The type checker to resolve aliases.
 */
export function classifyExportSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): SymbolKind {
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    return classifySymbol(aliased);
  }
  return classifySymbol(symbol);
}

/**
 * Resolves a module specifier relative to a barrel source file.
 * @param barrelSource - The barrel source file.
 * @param specifier - The module specifier string.
 * @param program - The TS program.
 */
export function resolveModuleFromBarrel(
  barrelSource: ts.SourceFile,
  specifier: string,
  program: ts.Program,
): string | undefined {
  const compilerOptions = program.getCompilerOptions();
  const resolved = ts.resolveModuleName(specifier, barrelSource.fileName, compilerOptions, ts.sys);
  return resolved.resolvedModule?.resolvedFileName;
}

/**
 * Walks up the directory tree to find the nearest package.json.
 * @param filePath - Starting file path.
 */
export function findPackageDir(filePath: string): string {
  let dir = path.dirname(filePath);
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`No package.json found for ${filePath}`);
}

/**
 * Walks up the directory tree to find the outer workspace root (outermost package.json).
 * @param filePath - Starting file path.
 */
export function findWorkspaceRoot(filePath: string): string {
  let dir = path.dirname(filePath);
  let lastPackageJsonDir: string | null = null;
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      lastPackageJsonDir = dir;
    }
    dir = path.dirname(dir);
  }
  if (!lastPackageJsonDir) throw new Error(`No workspace root found for ${filePath}`);
  return lastPackageJsonDir;
}

/**
 * Collects subpath export specifiers from a package.json exports map.
 * @param packageJson - Parsed package.json content.
 * @param packageName - The package name.
 */
export function collectSubpathSpecifiers(packageJson: Record<string, unknown>, packageName: string): string[] {
  const exports = packageJson['exports'] as Record<string, unknown> | undefined;
  if (!exports) return [];

  return Object.keys(exports)
    .filter((key) => key !== '.' && key.startsWith('./'))
    .map((key) => `${packageName}/${key.slice(2)}`);
}

/**
 * Creates a matcher for package root/subpath specifiers, including package
 * exports that use `*` wildcards.
 * @param specifiers - Package specifiers and subpath patterns to match.
 */
export function createPackageSpecifierMatcher(specifiers: readonly string[]): (specifier: string) => boolean {
  const exact = new Set(specifiers.filter((specifier) => !specifier.includes('*')));
  const wildcardPatterns = specifiers
    .filter((specifier) => specifier.includes('*'))
    .map((specifier) => {
      const [prefix, suffix] = specifier.split('*', 2);
      return { prefix, suffix };
    });

  return (specifier: string): boolean => {
    if (exact.has(specifier)) return true;
    return wildcardPatterns.some(
      ({ prefix, suffix }) =>
        specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length,
    );
  };
}

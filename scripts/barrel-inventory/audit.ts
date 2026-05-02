import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

import type { AuditSymbolEntry, PackageAuditResult } from './types.js';
import { classifyExportSymbol, createProgramForBarrel } from './ts-program.js';
import { findExternalConsumers } from './cross-check.js';

interface EntryPointFile {
  /** Concrete import specifier for this package entry point. */
  specifier: string;
  /** Absolute source file path backing the entry point. */
  filePath: string;
}

/**
 * Resolves the absolute path for an entry-point value from package.json exports.
 * Handles string values and conditional exports objects (picks the first string value).
 * @param value - The exports map value (string or conditions object).
 * @param packageDir - Absolute package directory for resolution.
 */
function resolveEntryPointPath(value: unknown, packageDir: string): string | null {
  if (typeof value === 'string') {
    return path.resolve(packageDir, value);
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const resolved = resolveEntryPointPath(v, packageDir);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Recursively lists source files under a directory.
 * @param dir - Directory to scan.
 */
function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Removes source-file extensions from wildcard subpath substitutions.
 * @param value - Wildcard text captured from a concrete source path.
 */
function stripSourceExtension(value: string): string {
  return value.replace(/\.(?:d\.)?(?:mts|cts|tsx?|jsx?)$/, '');
}

/**
 * Expands a wildcard package export into concrete source entry points.
 * @param key - Package exports key containing `*`.
 * @param value - Package exports value containing `*`.
 * @param packageDir - Absolute package directory.
 * @param packageName - Package name.
 */
function expandWildcardEntryPoints(
  key: string,
  value: unknown,
  packageDir: string,
  packageName: string,
): EntryPointFile[] {
  const pattern = resolveEntryPointPath(value, packageDir);
  if (!pattern || !pattern.includes('*')) return [];

  const [keyPrefix, keySuffix] = key.split('*', 2);
  const [pathPrefix, pathSuffix] = pattern.split('*', 2);
  const scanRoot = pathPrefix.endsWith(path.sep) ? pathPrefix.slice(0, -1) : path.dirname(pathPrefix);
  const files = listFilesRecursive(scanRoot);
  const entryPoints: EntryPointFile[] = [];

  for (const filePath of files) {
    if (!filePath.startsWith(pathPrefix) || !filePath.endsWith(pathSuffix)) continue;

    const wildcardValue = filePath.slice(pathPrefix.length, filePath.length - pathSuffix.length);
    const specifierSubpath = `${keyPrefix}${stripSourceExtension(wildcardValue)}${keySuffix}`.slice(2);
    entryPoints.push({
      specifier: `${packageName}/${specifierSubpath}`,
      filePath,
    });
  }

  return entryPoints.sort((a, b) => a.specifier.localeCompare(b.specifier));
}

/**
 * Collects concrete package entry points from a package exports map.
 * @param exportsMap - Parsed package.json exports map.
 * @param packageDir - Absolute package directory.
 * @param packageName - Package name.
 */
function collectPackageEntryPoints(
  exportsMap: Record<string, unknown>,
  packageDir: string,
  packageName: string,
): EntryPointFile[] {
  const entryPointFiles: EntryPointFile[] = [];

  for (const [key, value] of Object.entries(exportsMap)) {
    if (key === './package.json') continue;

    if (key.includes('*')) {
      const wildcardEntries = expandWildcardEntryPoints(key, value, packageDir, packageName);
      if (wildcardEntries.length === 0) {
        console.error(`  WARNING: Wildcard entry point "${key}" in ${packageName} matched no files`);
      }
      entryPointFiles.push(...wildcardEntries);
      continue;
    }

    const specifier = key === '.' ? packageName : `${packageName}/${key.slice(2)}`;
    const filePath = resolveEntryPointPath(value, packageDir);
    if (!filePath) {
      console.error(`  WARNING: Cannot resolve entry point "${key}" in ${packageName}`);
      continue;
    }
    if (!fs.existsSync(filePath)) {
      console.error(`  WARNING: Entry-point file does not exist: ${filePath}`);
      continue;
    }
    entryPointFiles.push({ specifier, filePath });
  }

  return entryPointFiles;
}

/**
 * Collects all exported symbols from a single entry-point source file.
 * Resolves through alias symbols to find the original declaration source file.
 * @param entrySpecifier - The import specifier for this entry point.
 * @param entryFile - Absolute path to the entry-point source file.
 * @param program - The shared TS program.
 * @param checker - The shared type checker.
 */
function collectEntryPointSymbols(
  entrySpecifier: string,
  entryFile: string,
  program: ts.Program,
  checker: ts.TypeChecker,
): AuditSymbolEntry[] {
  const sourceFile = program.getSourceFile(entryFile);
  if (!sourceFile) {
    console.error(`  WARNING: Entry-point source file not in program: ${entryFile}`);
    return [];
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    console.error(`  WARNING: No module symbol for: ${entryFile}`);
    return [];
  }

  const exports = checker.getExportsOfModule(moduleSymbol);
  const entries: AuditSymbolEntry[] = [];

  for (const sym of exports) {
    const name = sym.getName();
    const resolved = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const kind = classifyExportSymbol(sym, checker);
    const decl = resolved.declarations?.[0] ?? sym.declarations?.[0];
    const declFile = decl?.getSourceFile().fileName ?? entryFile;

    entries.push({ name, kind, sourceFile: declFile, entryPoint: entrySpecifier });
  }

  return entries;
}

/**
 * Audits all entry points of a package, cross-referencing against external
 * consumers to identify dead symbols and dead source files.
 * @param packageDir - Absolute path to the package directory.
 */
export async function auditPackage(packageDir: string): Promise<PackageAuditResult> {
  const pkgJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`No package.json found in ${packageDir}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
  const packageName = packageJson['name'];
  if (typeof packageName !== 'string') {
    throw new Error(`Package at ${packageDir} has no valid "name" field in package.json`);
  }

  const exportsMap = packageJson['exports'] as Record<string, unknown> | undefined;
  if (!exportsMap) {
    throw new Error(`Package ${packageName} has no "exports" field in package.json`);
  }

  const entryPointFiles = collectPackageEntryPoints(exportsMap, packageDir, packageName);

  if (entryPointFiles.length === 0) {
    throw new Error(`No resolvable entry points found for ${packageName}`);
  }

  console.error(`Loading TypeScript program for ${packageName}...`);
  const program = createProgramForBarrel(entryPointFiles[0].filePath);
  const checker = program.getTypeChecker();

  const allSymbols: AuditSymbolEntry[] = [];
  for (const { specifier, filePath } of entryPointFiles) {
    console.error(`  Scanning entry point: ${specifier}`);
    const symbols = collectEntryPointSymbols(specifier, filePath, program, checker);
    console.error(`    -> ${symbols.length} symbols`);
    allSymbols.push(...symbols);
  }

  const entryPoints = entryPointFiles.map((ep) => ep.specifier);

  const externalResult = await findExternalConsumers(entryPointFiles[0].filePath);
  const externallyConsumed = externalResult.values;

  return { packageName, packageDir, entryPoints, allSymbols, externallyConsumed };
}

/**
 * Prints the package audit report to stdout.
 * @param result - The audit result from {@link auditPackage}.
 */
export function printAuditReport(result: PackageAuditResult): void {
  const { packageName, packageDir, entryPoints, allSymbols, externallyConsumed } = result;

  const namespaceImport = externallyConsumed.has('*');

  const uniqueByName = new Map<string, AuditSymbolEntry>();
  for (const sym of allSymbols) {
    if (!uniqueByName.has(sym.name)) {
      uniqueByName.set(sym.name, sym);
    }
  }

  const totalUnique = uniqueByName.size;

  const deadSymbols = namespaceImport
    ? new Map<string, AuditSymbolEntry>()
    : new Map([...uniqueByName.entries()].filter(([name]) => !externallyConsumed.has(name)));

  const consumedCount = totalUnique - deadSymbols.size;

  const byFile = new Map<string, { dead: string[]; used: string[] }>();
  for (const [name, sym] of uniqueByName.entries()) {
    const relFile = path.relative(packageDir, sym.sourceFile);
    const entry = byFile.get(relFile) ?? { dead: [], used: [] };
    if (deadSymbols.has(name)) {
      entry.dead.push(name);
    } else {
      entry.used.push(name);
    }
    byFile.set(relFile, entry);
  }

  const sortedFiles = [...byFile.entries()].sort(([pathA, a], [pathB, b]) => {
    const aAllDead = a.used.length === 0;
    const bAllDead = b.used.length === 0;
    if (aAllDead !== bAllDead) return aAllDead ? -1 : 1;
    return pathA.localeCompare(pathB);
  });

  const deadFileCandidates = sortedFiles.filter(([, { used }]) => used.length === 0);

  const rootEntry = entryPoints.find((ep) => ep === packageName) ? '.' : '';
  const subpathCount = entryPoints.length - (rootEntry ? 1 : 0);
  const entryLabel =
    subpathCount > 0 ? `${entryPoints.length} (. + ${subpathCount} subpaths)` : `${entryPoints.length}`;

  console.log(`Package audit: ${packageName}`);
  console.log(`Entry points: ${entryLabel}`);
  console.log(`Total exported symbols: ${totalUnique}`);
  console.log(`Externally consumed: ${consumedCount}`);
  console.log(`Dead symbols: ${deadSymbols.size}`);

  if (namespaceImport) {
    console.log('\nNote: namespace import detected — all symbols conservatively treated as used.');
    return;
  }

  if (deadSymbols.size === 0) {
    console.log('\nNo dead symbols found.');
    return;
  }

  console.log('\nDead symbols by source file:\n');

  for (const [relFile, { dead, used }] of sortedFiles) {
    const total = dead.length + used.length;
    const allDead = used.length === 0;
    const label = allDead
      ? `${relFile} (${dead.length}/${total} dead) <- DEAD FILE`
      : `${relFile} (${dead.length}/${total} dead)`;
    console.log(`  ${label}`);

    const sortedDead = [...dead].sort((a, b) => a.localeCompare(b));
    const sortedUsed = [...used].sort((a, b) => a.localeCompare(b));

    for (const name of sortedDead) {
      console.log(`    ✗ ${name}`);
    }
    for (const name of sortedUsed) {
      console.log(`    ✓ ${name}`);
    }
    console.log();
  }

  console.log(`Dead file candidates (ALL exports unused): ${deadFileCandidates.length} files`);
  for (const [relFile] of deadFileCandidates) {
    console.log(`  ${relFile}`);
  }
}

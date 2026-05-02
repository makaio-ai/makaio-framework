import * as ts from 'typescript';

import type { BarrelInventory, DeadExportSet, ExportEntry, SymbolKind } from './types.js';
import { classifyExportSymbol, createProgramForBarrel, resolveModuleFromBarrel } from './ts-program.js';

/**
 * Collects exports from a single star-exported module into the groups map.
 * @param specifier - The module specifier from the barrel.
 * @param barrelSource - The barrel source file.
 * @param program - The TS program.
 * @param checker - The type checker.
 * @param groups - Map to populate with export entries.
 * @param allExportsByName - Tracks which specifiers export each name.
 */
function collectStarExports(
  specifier: string,
  barrelSource: ts.SourceFile,
  program: ts.Program,
  checker: ts.TypeChecker,
  groups: Map<string, ExportEntry[]>,
  allExportsByName: Map<string, string[]>,
): void {
  const resolvedModule = resolveModuleFromBarrel(barrelSource, specifier, program);
  if (!resolvedModule) {
    console.error(`  WARNING: Could not resolve module '${specifier}' from barrel`);
    return;
  }

  const moduleSource = program.getSourceFile(resolvedModule);
  if (!moduleSource) {
    console.error(`  WARNING: Source file not found: ${resolvedModule}`);
    return;
  }

  const moduleSymbol = checker.getSymbolAtLocation(moduleSource);
  if (!moduleSymbol) {
    console.error(`  WARNING: No symbol for module: ${resolvedModule}`);
    return;
  }

  const exports = checker.getExportsOfModule(moduleSymbol);
  const entries: ExportEntry[] = [];

  for (const exp of exports) {
    const name = exp.getName();
    const kind = classifyExportSymbol(exp, checker);
    entries.push({ name, kind, sourceSpecifier: specifier });

    const existing = allExportsByName.get(name) ?? [];
    existing.push(specifier);
    allExportsByName.set(name, existing);
  }

  entries.sort((a, b) => {
    const kindOrder = (k: SymbolKind) => (k === 'type' ? 1 : 0);
    const diff = kindOrder(a.kind) - kindOrder(b.kind);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  groups.set(specifier, entries);
}

/**
 * Collects exports from an explicit named export declaration into the groups map.
 * @param decl - The export declaration with named exports.
 * @param groups - Map to populate with export entries.
 * @param allExportsByName - Tracks which specifiers export each name.
 */
function collectExplicitExports(
  decl: ts.ExportDeclaration,
  groups: Map<string, ExportEntry[]>,
  allExportsByName: Map<string, string[]>,
): void {
  const specifier = (decl.moduleSpecifier as ts.StringLiteral).text;
  if (!decl.exportClause || !ts.isNamedExports(decl.exportClause)) return;

  const entries: ExportEntry[] = [];
  for (const element of decl.exportClause.elements) {
    const name = element.name.text;
    const sourceName = element.propertyName?.text;
    const isTypeOnly = decl.isTypeOnly || element.isTypeOnly;
    entries.push({
      name,
      ...(sourceName && sourceName !== name && { sourceName }),
      kind: isTypeOnly ? 'type' : 'both',
      sourceSpecifier: specifier,
    });

    const existing = allExportsByName.get(name) ?? [];
    existing.push(specifier);
    allExportsByName.set(name, existing);
  }

  const existing = groups.get(specifier) ?? [];
  existing.push(...entries);
  groups.set(specifier, existing);
}

/**
 * Builds a full inventory of all symbols exported through a barrel file.
 * Discovers both `export *` re-exports and explicit named exports.
 * @param barrelAbsPath - Absolute path to the barrel file.
 */
export function buildInventory(barrelAbsPath: string): BarrelInventory {
  const program = createProgramForBarrel(barrelAbsPath);
  const checker = program.getTypeChecker();

  const barrelSource = program.getSourceFile(barrelAbsPath);
  if (!barrelSource) {
    throw new Error(`Source file not found in program: ${barrelAbsPath}`);
  }

  const starExportSources: string[] = [];
  const explicitExports: ts.ExportDeclaration[] = [];

  for (const stmt of barrelSource.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier) continue;
    const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;

    if (!stmt.exportClause) {
      starExportSources.push(specifier);
    } else {
      explicitExports.push(stmt);
    }
  }

  const groups = new Map<string, ExportEntry[]>();
  const allExportsByName = new Map<string, string[]>();

  for (const specifier of starExportSources) {
    collectStarExports(specifier, barrelSource, program, checker, groups, allExportsByName);
  }

  for (const decl of explicitExports) {
    collectExplicitExports(decl, groups, allExportsByName);
  }

  const duplicates = new Map<string, string[]>();
  for (const [name, sources] of allExportsByName) {
    if (sources.length > 1) {
      duplicates.set(name, [...new Set(sources)]);
    }
  }

  return { barrelPath: barrelAbsPath, groups, duplicates };
}

/**
 * Returns true when the given entry appears in the dead-export set.
 * @param entry - The export entry to check.
 * @param dead - The dead export set produced by {@link invertToDeadSet}.
 */
export function isDeadExport(entry: ExportEntry, dead: DeadExportSet): boolean {
  return dead.values.has(entry.name) || dead.types.has(entry.name);
}

/**
 * Inverts a set of externally consumed symbol names into a dead-export set:
 * symbols NOT in `used` are dead.
 * @param inventory - The barrel inventory.
 * @param used - Set of symbol names that are externally consumed.
 */
export function invertToDeadSet(inventory: BarrelInventory, used: Set<string>): DeadExportSet {
  if (used.has('*')) {
    return { values: new Set(), types: new Set() };
  }

  const deadValues = new Set<string>();
  const deadTypes = new Set<string>();

  for (const entries of inventory.groups.values()) {
    for (const entry of entries) {
      if (!used.has(entry.name)) {
        if (entry.kind === 'type') {
          deadTypes.add(entry.name);
        } else {
          deadValues.add(entry.name);
        }
      }
    }
  }

  return { values: deadValues, types: deadTypes };
}

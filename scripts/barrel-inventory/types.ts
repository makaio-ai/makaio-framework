/** Classification of a symbol as value-only, type-only, or both. */
export type SymbolKind = 'value' | 'type' | 'both';

/** A single re-exported symbol discovered in a barrel file. */
export interface ExportEntry {
  /** Public exported symbol name. */
  name: string;
  /** Original source-module symbol name when the export is aliased. */
  sourceName?: string;
  /** Value/type/both classification. */
  kind: SymbolKind;
  /** The module specifier string from the barrel's export statement. */
  sourceSpecifier: string;
}

/** The full inventory of a barrel file's re-exports. */
export interface BarrelInventory {
  /** Absolute path to the barrel file. */
  barrelPath: string;
  /** Exports grouped by module specifier. */
  groups: Map<string, ExportEntry[]>;
  /** Symbol names that appear in multiple source modules. */
  duplicates: Map<string, string[]>;
}

/** Resolved set of dead (unconsumed) symbol names. */
export interface DeadExportSet {
  /** Value and mixed-kind symbol names that are dead. */
  values: Set<string>;
  /** Type-only symbol names that are dead. */
  types: Set<string>;
}

/** A single symbol collected during a full-package audit, with source location. */
export interface AuditSymbolEntry {
  /** Exported symbol name. */
  name: string;
  /** Value/type/both classification. */
  kind: SymbolKind;
  /** Absolute path of the source file where the symbol is originally declared. */
  sourceFile: string;
  /** Entry-point specifier (e.g. `@makaio/contracts/session`) via which this symbol is reachable. */
  entryPoint: string;
}

/** Full audit result for a package. */
export interface PackageAuditResult {
  /** Package name (from package.json `name`). */
  packageName: string;
  /** Absolute package directory. */
  packageDir: string;
  /** All entry-point specifiers (`packageName` + subpaths). */
  entryPoints: string[];
  /** Every exported symbol across all entry points (may contain duplicates by name). */
  allSymbols: AuditSymbolEntry[];
  /** Symbol names that are consumed externally (from `findExternalConsumers`). */
  externallyConsumed: Set<string>;
}

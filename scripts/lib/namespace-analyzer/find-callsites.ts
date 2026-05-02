import * as ts from 'typescript';

import { isFrameworkDistributionRoot, matchesInventoryPathPrefix, relativeInventoryPath } from './path-utils.js';
import type { NamespaceEntry } from './types.js';

/** Options controlling callsite scanning from a TypeScript program. */
export interface CallsiteScanOptions {
  /** POSIX path prefixes, relative to the analysis root, to skip during callsite scanning. */
  excludePathPrefixes?: readonly string[];
  /** Host policy that classifies callsite paths for documentation buckets. */
  classifyCallsiteTier?: (relativePath: string, analysisRoot: string) => 'framework' | 'product';
}

/**
 * Scans all source files for references to the Subjects constants exported by
 * each namespace and records them as framework or product callsites.
 * @param program - The TypeScript program covering the analysis workspace.
 * @param namespaces - Namespace entries to populate with callsite data.
 * @param analysisRoot - Absolute path to the analysis root directory.
 * @param options - Optional scan filters.
 */
export function findCallsites(
  program: ts.Program,
  namespaces: NamespaceEntry[],
  analysisRoot: string,
  options: CallsiteScanOptions = {},
): void {
  // Build a lookup: subjectsConstant → namespace entry
  const subjectsLookup = new Map<string, NamespaceEntry>();
  for (const ns of namespaces) {
    if (ns.subjectsConstant) {
      subjectsLookup.set(ns.subjectsConstant, ns);
    }
    // Also match by namespace constant (some files use FooNamespace.subjects directly)
    subjectsLookup.set(ns.namespaceConstant, ns);
  }

  if (subjectsLookup.size === 0) return;

  const frameworkCallsites = new Map<NamespaceEntry, Set<string>>();
  const productCallsites = new Map<NamespaceEntry, Set<string>>();

  for (const ns of namespaces) {
    frameworkCallsites.set(ns, new Set());
    productCallsites.set(ns, new Set());
  }

  let filesScanned = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes('node_modules')) continue;
    if (sourceFile.fileName.includes('__tests__')) continue;
    if (sourceFile.fileName.includes('.test.')) continue;
    if (matchesInventoryPathPrefix(analysisRoot, sourceFile.fileName, options.excludePathPrefixes)) continue;

    filesScanned++;
    scanFileForReferences(sourceFile, subjectsLookup, analysisRoot, frameworkCallsites, productCallsites, options);
  }

  console.error(`Scanned ${filesScanned} files for callsites`);

  for (const ns of namespaces) {
    ns.callsites.framework = [...(frameworkCallsites.get(ns) ?? [])].sort();
    ns.callsites.product = [...(productCallsites.get(ns) ?? [])].sort();
  }
}

/**
 * Scans import declarations in a single file for references to known
 * Subjects/Namespace constants and records the file as a callsite.
 * @param sourceFile - The TypeScript source file to scan.
 * @param subjectsLookup - Map from subjects/namespace constant name to its entry.
 * @param analysisRoot - Absolute path to the analysis root directory.
 * @param frameworkCallsites - Accumulator map for framework-tier callsites.
 * @param productCallsites - Accumulator map for product-tier callsites.
 * @param options - Callsite scan options, including host tier policy.
 */
function scanFileForReferences(
  sourceFile: ts.SourceFile,
  subjectsLookup: Map<string, NamespaceEntry>,
  analysisRoot: string,
  frameworkCallsites: Map<NamespaceEntry, Set<string>>,
  productCallsites: Map<NamespaceEntry, Set<string>>,
  options: CallsiteScanOptions,
): void {
  const relPath = relativeInventoryPath(analysisRoot, sourceFile.fileName);

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!stmt.importClause?.namedBindings) continue;
    if (!ts.isNamedImports(stmt.importClause.namedBindings)) continue;

    for (const element of stmt.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const ns = subjectsLookup.get(importedName);
      if (!ns) continue;

      // Don't count the file where the namespace is defined
      if (relPath === ns.definedIn.file) continue;

      const tier = isFrameworkDistributionRoot(analysisRoot)
        ? 'framework'
        : (options.classifyCallsiteTier?.(relPath, analysisRoot) ?? 'product');
      const bucket = tier === 'framework' ? frameworkCallsites : productCallsites;
      bucket.get(ns)?.add(relPath);
    }
  }
}

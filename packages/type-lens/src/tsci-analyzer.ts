import * as path from 'node:path';
import { Project, SyntaxKind, type ClassDeclaration, type Node, type SourceFile } from 'ts-morph';
import QuickLRU from 'quick-lru';
import type { SymbolNode, SymbolKind, MemberInfo } from './schemas.js';
import type { LanguageAnalyzer, MethodCallTarget } from './types.js';
import {
  extractMembers as extractMembersFromSource,
  extractDocSummary as extractDocSummaryFromSource,
  extractExecutableMembers,
} from './member-extractor.js';
import { isEligibleFile } from './index-utils.js';
import {
  findDeclaration,
  getClassHierarchy,
  getInterfaceHierarchy,
  extractClasses,
  extractInterfaces,
  extractFunctions,
  extractTypeAliases,
  extractEnums,
  findMethodNode,
} from './symbol-extractor.js';

/** Default max cached source files before LRU eviction. */
export const DEFAULT_CACHE_SIZE = 50;

/** Cache performance counters returned by {@link TsciAnalyzer.getStats}. */
export type AnalyzerStats = {
  /** Current number of source files held in the LRU cache. */
  cacheSize: number;
  /** Total cache hits since the analyzer was constructed. */
  cacheHits: number;
  /** Total cache misses since the analyzer was constructed. */
  cacheMisses: number;
};

/**
 * TypeScript Code Intelligence Analyzer.
 *
 * Parses files on-demand with LRU-bounded caching. Source files are
 * cached for efficiency, with least-recently-used files evicted when
 * the cache reaches capacity.
 */
export class TsciAnalyzer implements LanguageAnalyzer {
  public readonly language = 'typescript';
  public readonly extensions = ['.ts', '.tsx'];

  private project: Project;
  private readonly cache: QuickLRU<string, SourceFile>;
  private currentTsConfigFilePath: string | undefined;
  // Cache counters are cumulative across all tasks dispatched to this
  // worker (the analyzer is a long-lived singleton at module scope).
  // The WorkerCompleteMessage carries lifetime totals, not per-task deltas.
  private cacheHits = 0;
  private cacheMisses = 0;

  /**
   * Create a new TsciAnalyzer.
   *
   * The analyzer is root-agnostic: one shared instance can serve multiple
   * scopes. The LRU cache keys on absolute paths, which are unique across
   * scopes.
   * @param options - Optional configuration. `maxCacheSize` caps the LRU cache
   *   (default: 50). `tsConfigFilePath` enables monorepo path alias resolution;
   *   when omitted, aliases are not resolved.
   */
  public constructor(options?: { maxCacheSize?: number; tsConfigFilePath?: string }) {
    const cacheSize = options?.maxCacheSize ?? DEFAULT_CACHE_SIZE;
    this.currentTsConfigFilePath = options?.tsConfigFilePath;
    this.project = this.createProject(this.currentTsConfigFilePath);

    this.cache = new QuickLRU<string, SourceFile>({
      maxSize: cacheSize,
      onEviction: (_key, sourceFile) => {
        this.project.removeSourceFile(sourceFile);
      },
    });
  }

  /**
   * Get cache statistics for observability.
   * @returns Cache size, hit count, and miss count since construction.
   */
  public getStats(): AnalyzerStats {
    return { cacheSize: this.cache.size, cacheHits: this.cacheHits, cacheMisses: this.cacheMisses };
  }

  /**
   * Resize the source-file LRU cache in-place.
   *
   * Call this before a cold full-index pass to prevent eviction-driven
   * deceleration, then restore the default size afterward:
   *
   * ```ts
   * analyzer.resizeCache(filePaths.length); // hold everything
   * try {
   *   await fullIndexPass(filePaths);
   * } finally {
   *   analyzer.resizeCache(DEFAULT_CACHE_SIZE); // restore steady-state limit
   * }
   * ```
   * @param maxSize - New maximum number of source files to retain in the cache.
   *   Must be greater than 0.
   */
  public resizeCache(maxSize: number): void {
    if (maxSize <= 0) {
      throw new Error('maxSize must be greater than 0');
    }
    this.cache.resize(maxSize);
  }

  /**
   * Update the tsconfig used for module/path resolution.
   * Rebuilds the underlying ts-morph Project only when the path changes.
   * @param tsConfigFilePath - Absolute tsconfig path, or undefined to disable tsconfig-backed resolution.
   */
  public setTsConfigFilePath(tsConfigFilePath: string | undefined): void {
    const normalized = tsConfigFilePath ? path.resolve(tsConfigFilePath) : undefined;
    if (normalized === this.currentTsConfigFilePath) {
      return;
    }

    this.cache.clear();
    for (const sourceFile of this.project.getSourceFiles()) {
      this.project.removeSourceFile(sourceFile);
    }
    this.project = this.createProject(normalized);
    this.currentTsConfigFilePath = normalized;
  }

  /**
   * Clean up resources held by the analyzer.
   * Clears the cache and removes all source files from the ts-morph Project.
   */
  public dispose(): void {
    this.cache.clear();
    for (const sourceFile of this.project.getSourceFiles()) {
      this.project.removeSourceFile(sourceFile);
    }
  }

  /**
   * Create a ts-morph project for the current tsconfig setting.
   * @param tsConfigFilePath - Absolute tsconfig path, or undefined.
   * @returns Configured ts-morph project.
   */
  private createProject(tsConfigFilePath: string | undefined): Project {
    return new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      tsConfigFilePath,
      compilerOptions: {
        skipLibCheck: true,
        noEmit: true,
      },
    });
  }

  /**
   * Get or add source file to project with LRU caching.
   * Uses cached version if available, refreshing from disk if changed.
   * @param file - Absolute file path
   * @returns The ts-morph SourceFile
   * @throws Error if the file does not exist or cannot be read
   */
  private getSourceFile(file: string) {
    const cached = this.cache.get(file);
    if (cached) {
      this.cacheHits++;
      cached.refreshFromFileSystemSync();
      return cached;
    }

    this.cacheMisses++;
    let sourceFile;
    try {
      sourceFile = this.project.addSourceFileAtPath(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load source file '${file}': ${message}`);
    }
    this.cache.set(file, sourceFile);
    return sourceFile;
  }

  /**
   * Parse file and extract all symbols.
   * @param file - Absolute file path to parse
   * @param relativeFilePath - Optional pre-computed relative path used as
   *   the `file` field on each emitted symbol. Falls back to
   *   the normalized absolute file path when omitted.
   * @returns Array of symbols found in the file
   */
  public async parseFile(file: string, relativeFilePath?: string): Promise<SymbolNode[]> {
    const sourceFile = this.getSourceFile(file);
    // Absolute-path fallback preserves uniqueness when callers omit relativeFilePath.
    const relPath = relativeFilePath ?? path.resolve(file);

    return [
      ...extractClasses(sourceFile, relPath),
      ...extractInterfaces(sourceFile, relPath),
      ...extractFunctions(sourceFile, relPath),
      ...extractTypeAliases(sourceFile, relPath),
      ...extractEnums(sourceFile, relPath),
      ...sourceFile.getClasses().flatMap((cls) => extractExecutableMembers(cls, relPath)),
    ];
  }

  /**
   * Extract members from a symbol.
   * @param file - Absolute file path
   * @param name - Symbol name to extract members from
   * @param kind - Symbol kind (class/interface)
   * @returns Array of member information
   */
  public async extractMembers(file: string, name: string, kind: SymbolKind): Promise<MemberInfo[]> {
    const sourceFile = this.getSourceFile(file);
    return extractMembersFromSource(sourceFile, name, kind);
  }

  /**
   * Extract JSDoc summary from a symbol.
   * @param file - Absolute file path
   * @param name - Symbol name to extract docs from
   * @param kind - Symbol kind
   * @returns JSDoc description or undefined if none found
   */
  public async extractDocSummary(file: string, name: string, kind: SymbolKind): Promise<string | undefined> {
    const sourceFile = this.getSourceFile(file);
    return extractDocSummaryFromSource(sourceFile, name, kind);
  }

  /**
   * Find the position of a symbol (1-based).
   * @param file - Absolute file path
   * @param name - Symbol name
   * @param kind - Optional symbol kind filter
   * @returns Position or null if not found
   */
  public async findSymbolPosition(
    file: string,
    name: string,
    kind?: SymbolKind,
  ): Promise<{ line: number; column: number } | null> {
    const sourceFile = this.getSourceFile(file);
    const declaration = findDeclaration(sourceFile, name, kind);
    if (!declaration) return null;

    const nameNode = (declaration as { getNameNode?: () => Node | undefined }).getNameNode?.();
    const position = sourceFile.getLineAndColumnAtPos((nameNode ?? declaration).getStart());
    return { line: position.line, column: position.column };
  }

  /**
   * Get the inheritance chain for class or interface.
   * @param file - Absolute file path
   * @param name - Symbol name
   * @returns Chain of names, starting with the symbol
   */
  public async getTypeHierarchy(file: string, name: string): Promise<string[] | null> {
    const sourceFile = this.getSourceFile(file);

    const classChain = getClassHierarchy(sourceFile, name);
    if (classChain) return classChain;

    const interfaceChain = getInterfaceHierarchy(sourceFile, name);
    if (interfaceChain) return interfaceChain;

    return null;
  }

  /**
   * Extract the source body of a method or standalone function.
   *
   * For class members, searches both `MethodDeclaration` nodes and
   * arrow-function `PropertyDeclaration` nodes.
   * @param file - Absolute file path
   * @param className - Containing class name, or null for standalone functions
   * @param methodName - Method or function name
   * @returns Source body text and start line, or null when not found
   */
  public async extractMethodBody(
    file: string,
    className: string | null,
    methodName: string,
  ): Promise<{ body: string; line: number } | null> {
    const sourceFile = this.getSourceFile(file);
    const node = findMethodNode(sourceFile, className, methodName);
    if (!node) return null;
    return { body: node.getText(), line: node.getStartLineNumber() };
  }

  /**
   * Resolve all outgoing calls in a method body to their declaration sites.
   *
   * Only follows calls whose declaration resolves to a file within `scopePath`
   * (or a file whose package matches `includePackages`). Unresolvable or
   * external calls are silently skipped.
   * @param file - Absolute file path of the calling method
   * @param className - Containing class, or null for standalone functions
   * @param methodName - Calling method name
   * @param scopePath - Workspace root for filtering
   * @param includePackages - Optional package allowlist
   * @returns Resolved call targets
   */
  public async resolveMethodCalls(
    file: string,
    className: string | null,
    methodName: string,
    scopePath: string,
    includePackages?: string[],
  ): Promise<MethodCallTarget[]> {
    const sourceFile = this.getSourceFile(file);
    const methodNode = findMethodNode(sourceFile, className, methodName);
    if (!methodNode) return [];

    const callExprs = methodNode.getDescendantsOfKind(SyntaxKind.CallExpression);
    const seen = new Set<string>();
    const targets: MethodCallTarget[] = [];

    for (const callExpr of callExprs) {
      try {
        const localSym = callExpr.getExpression().getSymbol();
        // Follow the full alias chain to the canonical declaration.
        // A single hop misses barrel re-exports where the chain is deeper than one level.
        // Loop until the symbol stabilises (aliased === self) or there is no further alias.
        let sym = localSym;
        while (sym) {
          const aliased = sym.getAliasedSymbol();
          if (!aliased || aliased === sym) break;
          sym = aliased;
        }
        const declarations = sym?.getDeclarations();
        if (!declarations || declarations.length === 0) continue;

        // Take the last declaration — for overloads, the implementation body follows the overload stubs.
        const decl = declarations[declarations.length - 1];
        const targetPath = decl.getSourceFile().getFilePath();

        if (!isEligibleFile(targetPath, scopePath, includePackages)) continue;

        // Walk parent chain to find containing class, if any.
        let containingClassName: string | null = null;
        let parent = decl.getParent();
        while (parent) {
          if (parent.getKind() === SyntaxKind.ClassDeclaration) {
            const name = (parent as ClassDeclaration).getName?.();
            containingClassName = name ?? null;
            break;
          }
          parent = parent.getParent();
        }

        // Determine the method/function name from the declaration node.
        const declName = (decl as { getName?: () => string | undefined }).getName?.();
        if (!declName) continue;

        const key = `${targetPath}:${containingClassName}:${declName}`;
        if (seen.has(key)) continue;
        seen.add(key);

        targets.push({
          file: targetPath,
          className: containingClassName,
          methodName: declName,
          line: decl.getStartLineNumber(),
        });
      } catch {
        // Silently skip unresolvable calls per plan's catch-per-node strategy.
      }
    }

    return targets;
  }
}

import * as path from 'node:path';
import { Project, SyntaxKind, type CallExpression, type ClassDeclaration, type Node, type SourceFile } from 'ts-morph';
import QuickLRU from 'quick-lru';
import type { SymbolNode, SymbolKind, MemberInfo } from './schemas.js';
import type { FileCallEdge, LanguageAnalyzer, MethodCallTarget } from './types.js';
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

/** Caller attribution for a call expression within a source file. */
type CallerAttribution = {
  /** Containing class of the calling code, or null for free functions / file-level code. */
  callerClassName: string | null;
  /** Name of the calling method, function, or arrow-function variable. Null for top-level statements. */
  callerName: string | null;
  /** 1-based line of the indexed caller declaration, or undefined for top-level/unindexed calls. */
  callerDeclarationLine?: number;
};

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
   *   (default: 50). `tsConfigFilePath` enables workspace path alias resolution;
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
   * Get the configured maximum number of source files retained in the LRU cache.
   * @returns Current cache max size.
   */
  public getCacheMaxSize(): number {
    return this.cache.maxSize;
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
   * Obtain the underlying TypeScript compiler program.
   *
   * Useful for passing to {@link TypeAnalyzer.fromProgram} without exposing the
   * ts-morph Project itself. The returned program is a snapshot — the caller
   * must not cache it across source-file mutations.
   * @returns The TypeScript compiler program from the ts-morph project.
   */
  public getCompilerProgram() {
    // The ts-morph Project uses the same runtime typescript package, but
    // @ts-morph/common re-declares the TypeScript namespace in its own .d.ts
    // file, creating a nominal type mismatch.  The compilerObject is
    // structurally identical to the typescript package's ts.Program at runtime;
    // callers that need the canonical ts.Program type should bridge via
    // structurally typed helper parameters.
    return this.project.getProgram().compilerObject;
  }

  /**
   * Ensure a source file is loaded into the project for checker resolution.
   *
   * Unlike {@link parseFile}, this only materialises the file in the ts-morph
   * Project so it participates in checker queries. No symbol extraction is
   * performed.
   * @param file - Absolute file path to touch.
   */
  public touchFile(file: string): void {
    this.getSourceFile(file);
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
      throw new Error(`Failed to load source file '${file}': ${message}`, { cause: error });
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
   * @param namespacePath - Containing class/namespace for method symbols.
   * @returns JSDoc description or undefined if none found
   */
  public async extractDocSummary(
    file: string,
    name: string,
    kind: SymbolKind,
    namespacePath?: string | null,
  ): Promise<string | undefined> {
    const sourceFile = this.getSourceFile(file);
    return extractDocSummaryFromSource(sourceFile, name, kind, namespacePath ?? null);
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
      if (this.isDecoratorMetadataCall(callExpr)) continue;

      const resolved = this.resolveCallExpression(callExpr, scopePath, includePackages);
      if (!resolved) continue;

      const key = `${resolved.file}:${resolved.className}:${resolved.methodName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      targets.push(resolved);
    }

    return targets;
  }

  /**
   * Resolve all outgoing calls across an entire source file, attributing each
   * call to its containing declaration (method, function, or arrow variable).
   *
   * Only follows calls whose declaration resolves to a file within `scopePath`
   * (or a file whose package matches `includePackages`). Unresolvable or
   * external calls are silently skipped.
   * @param file - Absolute file path to scan
   * @param scopePath - Workspace root for filtering
   * @param includePackages - Optional package allowlist
   * @returns Resolved call edges attributed to their callers
   */
  public async resolveFileCallEdges(
    file: string,
    scopePath: string,
    includePackages?: string[],
  ): Promise<FileCallEdge[]> {
    const sourceFile = this.getSourceFile(file);
    const callExprs = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    const seen = new Set<string>();
    const edges: FileCallEdge[] = [];

    for (const callExpr of callExprs) {
      if (this.isDecoratorMetadataCall(callExpr)) continue;

      const target = this.resolveCallExpression(callExpr, scopePath, includePackages);
      if (!target) continue;

      const callLine = callExpr.getStartLineNumber();
      const caller = this.attributeCallToCaller(callExpr);
      const callerKey =
        caller.callerName === null
          ? `top-level:${callExpr.getStart()}`
          : `${caller.callerClassName}:${caller.callerName}`;
      const key = [callerKey, caller.callerDeclarationLine, target.file, target.className, target.methodName].join(':');
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({ ...caller, callLine, target });
    }

    return edges;
  }

  /**
   * Resolve a single call expression to its declaration-site target.
   *
   * Follows the full alias chain to the canonical declaration (handles barrel
   * re-exports). Returns null for unresolvable calls or calls outside the scope.
   * @param callExpr - The ts-morph CallExpression node to resolve
   * @param scopePath - Workspace root for filtering
   * @param includePackages - Optional package allowlist
   * @returns Resolved target, or null when skipped
   */
  private resolveCallExpression(
    callExpr: CallExpression,
    scopePath: string,
    includePackages?: string[],
  ): MethodCallTarget | null {
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
      if (!declarations || declarations.length === 0) return null;

      // Take the last declaration — for overloads, the implementation body follows the overload stubs.
      const decl = declarations[declarations.length - 1];
      const targetPath = decl.getSourceFile().getFilePath();

      if (!isEligibleFile(targetPath, scopePath, includePackages)) return null;

      const identity = this.getIndexedCallableIdentity(decl);
      if (!identity) return null;

      return {
        file: targetPath,
        className: identity.className,
        methodName: identity.name,
        line: decl.getStartLineNumber(),
      };
    } catch {
      // Silently skip unresolvable calls per plan's catch-per-node strategy.
      return null;
    }
  }

  /**
   * Attribute a call expression to its containing declaration.
   *
   * Walks ancestors of the call to find the nearest enclosing method, function,
   * or arrow-function variable. Returns class name and method/function name.
   * @param callExpr - The call expression to attribute
   * @returns Caller class name and method/function name (both nullable)
   */
  private attributeCallToCaller(callExpr: CallExpression): CallerAttribution {
    let node: Node | undefined = callExpr.getParent();

    while (node) {
      const result = this.tryAttributeNode(node, callExpr);
      if (result) return result;
      node = node.getParent();
    }

    // Top-level statement or unattributable
    return { callerClassName: null, callerName: null };
  }

  /**
   * Try to attribute a call to a single ancestor node.
   *
   * Returns a {@link CallerAttribution} when the node is a recognizable
   * declaration boundary (method, property, function, or top-level variable),
   * or null to continue walking.
   * @param node - Ancestor node to inspect
   * @param callExpr - Original call expression being attributed
   * @returns Attribution if the node is a declaration boundary, null otherwise
   */
  private tryAttributeNode(node: Node, callExpr: CallExpression): CallerAttribution | null {
    const kind = node.getKind();

    // Method declaration inside a class: always a function boundary.
    if (kind === SyntaxKind.MethodDeclaration) {
      const memberName = (node as { getName?: () => string | undefined }).getName?.() ?? null;
      const className = this.getParentClassName(node);
      if (!className) return null;
      return {
        callerClassName: className,
        callerName: memberName,
        callerDeclarationLine: node.getStartLineNumber(),
      };
    }

    // Property declaration inside a class: only a boundary when the
    // initializer is a function/arrow (e.g. `action = () => { ... }`).
    // Plain field initializers like `field = someCall()` must fall through
    // so the call is not mis-attributed to the property name.
    if (kind === SyntaxKind.PropertyDeclaration) {
      return this.tryAttributePropertyDeclaration(node, callExpr);
    }

    // Standalone function declaration
    if (kind === SyntaxKind.FunctionDeclaration) {
      if (!this.hasSourceFileParent(node)) return null;
      const fnName = (node as { getName?: () => string | undefined }).getName?.() ?? null;
      return {
        callerClassName: null,
        callerName: fnName,
        callerDeclarationLine: node.getStartLineNumber(),
      };
    }

    // Top-level variable declaration with function/arrow initializer
    if (kind === SyntaxKind.VariableDeclaration) {
      return this.tryAttributeTopLevelVariableDeclaration(node, callExpr);
    }

    return null;
  }

  /**
   * Attribute a call to a class property only when that property owns a
   * function-like initializer.
   * @param node - Property declaration ancestor to inspect.
   * @param callExpr - Original call expression being attributed.
   * @returns Attribution for arrow/function-expression properties, otherwise null.
   */
  private tryAttributePropertyDeclaration(node: Node, callExpr: CallExpression): CallerAttribution | null {
    const initializer = (node as { getInitializer?: () => Node | undefined }).getInitializer?.();
    if (!initializer || !this.isFunctionInitializerContainingCall(initializer, callExpr)) return null;

    const memberName = (node as { getName?: () => string | undefined }).getName?.() ?? null;
    const className = this.getParentClassName(node);
    if (!className) return null;
    return {
      callerClassName: className,
      callerName: memberName,
      callerDeclarationLine: node.getStartLineNumber(),
    };
  }

  /**
   * Attribute a call to a top-level variable only when the variable owns a
   * function-like initializer.
   * @param node - Variable declaration ancestor to inspect.
   * @param callExpr - Original call expression being attributed.
   * @returns Attribution for top-level arrow/function-expression variables, otherwise null.
   */
  private tryAttributeTopLevelVariableDeclaration(node: Node, callExpr: CallExpression): CallerAttribution | null {
    if (!this.isTopLevelVariableDeclaration(node)) return null;

    const initializer = (node as { getInitializer?: () => Node | undefined }).getInitializer?.();
    if (!initializer || !this.isFunctionInitializerContainingCall(initializer, callExpr)) return null;

    const varName = (node as { getName?: () => string | undefined }).getName?.() ?? null;
    return {
      callerClassName: null,
      callerName: varName,
      callerDeclarationLine: node.getStartLineNumber(),
    };
  }

  /**
   * Resolve a declaration to an indexed callable identity.
   *
   * Local/nested declarations are deliberately excluded because the index only
   * contains top-level functions, top-level arrow/function variables, and
   * top-level class members. Reporting a local declaration by file/name would let
   * enrichment attach it to an unrelated indexed top-level symbol with the same
   * name.
   * @param declaration - Resolved call target declaration.
   * @returns Indexed callable identity, or null for unindexed local declarations.
   */
  private getIndexedCallableIdentity(declaration: Node): { className: string | null; name: string } | null {
    const kind = declaration.getKind();

    switch (kind) {
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.PropertyDeclaration:
        return this.getIndexedClassMemberIdentity(declaration);
      case SyntaxKind.FunctionDeclaration:
        return this.getIndexedTopLevelFunctionIdentity(declaration);
      case SyntaxKind.VariableDeclaration:
        return this.getIndexedTopLevelVariableIdentity(declaration);
      default:
        return null;
    }
  }

  /**
   * Resolve an indexed class member declaration identity.
   * @param declaration - Method or property declaration.
   * @returns Class-member identity, or null when the class is not indexed.
   */
  private getIndexedClassMemberIdentity(declaration: Node): { className: string; name: string } | null {
    const className = this.getParentClassName(declaration);
    const name = (declaration as { getName?: () => string | undefined }).getName?.();
    return className && name ? { className, name } : null;
  }

  /**
   * Resolve an indexed top-level function declaration identity.
   * @param declaration - Function declaration.
   * @returns Top-level function identity, or null for nested functions.
   */
  private getIndexedTopLevelFunctionIdentity(declaration: Node): { className: null; name: string } | null {
    if (!this.hasSourceFileParent(declaration)) return null;
    const name = (declaration as { getName?: () => string | undefined }).getName?.();
    return name ? { className: null, name } : null;
  }

  /**
   * Resolve an indexed top-level variable-function declaration identity.
   * @param declaration - Variable declaration.
   * @returns Top-level variable function identity, or null for nested variables.
   */
  private getIndexedTopLevelVariableIdentity(declaration: Node): { className: null; name: string } | null {
    if (!this.isTopLevelVariableDeclaration(declaration)) return null;

    const name = (declaration as { getName?: () => string | undefined }).getName?.();
    return name ? { className: null, name } : null;
  }

  /**
   * Check whether a variable declaration is an indexed top-level declaration.
   * @param declaration - Variable declaration candidate.
   * @returns True when the variable statement is a direct child of the source file.
   */
  private isTopLevelVariableDeclaration(declaration: Node): boolean {
    const parent = declaration.getParent();
    return (
      parent?.getKind() === SyntaxKind.VariableDeclarationList &&
      parent.getParent()?.getKind() === SyntaxKind.VariableStatement &&
      this.hasSourceFileParent(parent.getParent())
    );
  }

  /**
   * Check whether an initializer is a function-like owner for the given call.
   *
   * Plain initializers such as `const value = util()` and `field = util()`
   * execute at file/class initialization time, not within an indexed function
   * symbol. Only arrow-function and function-expression initializers own calls.
   * @param initializer - Variable or property initializer to inspect
   * @param callExpr - Call expression being attributed
   * @returns True when the call is inside a function-like initializer
   */
  private isFunctionInitializerContainingCall(initializer: Node, callExpr: CallExpression): boolean {
    const kind = initializer.getKind();
    if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) return false;

    let node: Node | undefined = callExpr;
    while (node) {
      if (node === initializer) return true;
      node = node.getParent();
    }

    return false;
  }

  /**
   * Check whether a call belongs to decorator metadata rather than executable
   * function/method code.
   * @param callExpr - Call expression being considered for call-edge enrichment.
   * @returns True when the call is nested inside a decorator expression.
   */
  private isDecoratorMetadataCall(callExpr: CallExpression): boolean {
    return callExpr.getAncestors().some((ancestor) => ancestor.getKind() === SyntaxKind.Decorator);
  }

  /**
   * Extract the class name from a node's direct parent, when that class is indexed.
   * @param node - Node whose parent to inspect
   * @returns Class name or null if the parent is not a top-level class declaration.
   */
  private getParentClassName(node: Node): string | null {
    const classNode = node.getParent();
    if (classNode?.getKind() === SyntaxKind.ClassDeclaration && this.hasSourceFileParent(classNode)) {
      return (classNode as ClassDeclaration).getName?.() ?? null;
    }
    return null;
  }

  /**
   * Check whether a node is a direct child of the source file.
   * @param node - Node to inspect.
   * @returns True when the node's parent is the source file.
   */
  private hasSourceFileParent(node: Node | undefined): boolean {
    return node?.getParent()?.getKind() === SyntaxKind.SourceFile;
  }
}

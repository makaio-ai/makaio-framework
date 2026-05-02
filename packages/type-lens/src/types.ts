import type { SymbolNode, SymbolKind, MemberInfo } from './schemas.js';

/**
 * A resolved outgoing call from one method to another.
 */
export interface MethodCallTarget {
  /** Absolute file path of the callee declaration. */
  file: string;
  /** Containing class name, or null for standalone functions. */
  className: string | null;
  /** Method or function name. */
  methodName: string;
  /** 1-based line number of the callee declaration. */
  line: number;
}

/**
 * Language analyzer interface.
 *
 * SEAM: Implementations for TypeScript, Python, etc.
 */
export interface LanguageAnalyzer {
  /** Language identifier */
  readonly language: string;
  /** File extensions handled */
  readonly extensions: string[];

  /** Parse file to extract symbols */
  parseFile(file: string, relativeFilePath?: string): Promise<SymbolNode[]>;

  /** Extract members from a symbol (for hover/detail) */
  extractMembers(file: string, name: string, kind: SymbolKind): Promise<MemberInfo[]>;

  /** Extract JSDoc summary */
  extractDocSummary(file: string, name: string, kind: SymbolKind): Promise<string | undefined>;

  /** Find symbol position (1-based line/column). */
  findSymbolPosition(file: string, name: string, kind?: SymbolKind): Promise<{ line: number; column: number } | null>;

  /** Get inheritance chain for a class or interface. */
  getTypeHierarchy?(file: string, name: string): Promise<string[] | null>;

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
  extractMethodBody?(
    file: string,
    className: string | null,
    methodName: string,
  ): Promise<{ body: string; line: number } | null>;

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
  resolveMethodCalls?(
    file: string,
    className: string | null,
    methodName: string,
    scopePath: string,
    includePackages?: string[],
  ): Promise<MethodCallTarget[]>;

  /**
   * Reconfigure path-alias resolution for the current workspace.
   * Implementations should treat `undefined` as "no tsconfig available".
   * @param tsConfigFilePath - Absolute tsconfig path to use for module resolution.
   */
  setTsConfigFilePath?(tsConfigFilePath: string | undefined): void;

  /** Clean up resources held by the analyzer */
  dispose(): void;
}

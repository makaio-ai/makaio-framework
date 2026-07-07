import path from 'node:path';
import ts from 'typescript';
import type { ResolvedTypeShape } from './schemas.js';

export interface TypeAnalyzerOptions {
  /** Public API entrypoint files that export the symbols being analyzed. */
  entryPoints: string[];
  /** Optional tsconfig used for module resolution and compiler options. */
  tsconfigPath?: string;
  /** Maximum number of object properties to render before omitting a shape. */
  maxShapeProperties?: number;
}

export interface TypeCompositionNode {
  /** Human-readable type expression or symbol name for this node. */
  text: string;
  /** API symbol name when this node represents a local documented symbol. */
  symbolName?: string;
  /** Nested type references that explain this node's composition. */
  children: TypeCompositionNode[];
}

export interface TypeAliasAnalysis {
  /** Public type alias symbol name. */
  symbolName: string;
  /** Composition tree rooted at the public type alias. */
  composition: TypeCompositionNode;
  /** Compact final object shape when the alias resolves to one within limits. */
  resolvedShape?: ResolvedTypeShape;
}

const DEFAULT_MAX_SHAPE_PROPERTIES = 40;
const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

/**
 * Structural interface for a TypeScript compiler program.
 *
 * Decouples {@link TypeAnalyzer.fromProgram} and heritage-resolution helpers
 * from the nominal `ts.Program` type so callers that hold a structurally
 * identical program object (e.g. the `compilerObject` returned by ts-morph,
 * which is typed under `@ts-morph/common`'s re-declared TypeScript namespace)
 * can pass it without a double-cast.
 *
 * At runtime these objects are the same `ts.Program` instance; only the
 * declaration-level nominal brand differs.  The member return types are
 * intentionally `unknown` rather than `ts.TypeChecker` / `ts.SourceFile` —
 * those nominal types would reintroduce the very mismatch this interface
 * exists to avoid.  Consumers cast the object to `ts.Program` at the
 * boundary where full nominal typing resumes.
 */
export interface CompilerProgramLike {
  /** Obtain the type checker for semantic queries. */
  getTypeChecker(): unknown;
  /** Retrieve a parsed source file by its file name. */
  getSourceFile(fileName: string): unknown;
}

/**
 * Bridge a {@link CompilerProgramLike} to the nominal `ts.Program` type.
 *
 * At runtime the object IS a `ts.Program` — the nominal type gap exists only
 * in declaration files (e.g. `@ts-morph/common` re-declares the TypeScript
 * namespace).  This helper centralizes the single unavoidable assertion so
 * call-sites stay clean.
 * @param program - Structurally compatible program object.
 * @returns The same object typed as `ts.Program`.
 */
export function asCompilerProgram(program: CompilerProgramLike): ts.Program {
  // Safe: CompilerProgramLike is a strict subset of ts.Program, and at
  // runtime the object is always a genuine ts.Program instance.
  return program as ts.Program;
}

/**
 * Compiler-backed analyzer for TypeScript type aliases and interfaces.
 */
export class TypeAnalyzer {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly entryPoints: string[];
  private readonly maxShapeProperties: number;

  /**
   * Creates a TypeAnalyzer that wraps an externally provided TypeScript program.
   *
   * Use this factory when the caller already owns a compiled program (e.g. from
   * ts-morph or a language-service host). The analyzer skips `ts.createProgram`
   * and reuses the existing type checker.
   *
   * The parameter accepts {@link CompilerProgramLike} rather than the nominal
   * `ts.Program` to avoid type mismatches when the program originates from a
   * wrapper library (e.g. ts-morph) that re-declares the TypeScript namespace.
   *
   * Export-lookup via {@link analyzeExportedTypeAlias} is unavailable on
   * analyzers created through this factory because no entrypoints are
   * configured. Use {@link analyzeDeclarationAt} instead.
   * @param program - Pre-compiled TypeScript program (or structurally
   *   compatible object such as ts-morph's `compilerObject`).
   * @param options - Optional rendering limits.
   * @returns A TypeAnalyzer bound to the provided program.
   */
  public static fromProgram(program: CompilerProgramLike, options?: { maxShapeProperties?: number }): TypeAnalyzer {
    // The structural interface guarantees getTypeChecker/getSourceFile are
    // present.  At runtime the object is always a genuine ts.Program; the
    // cast bridges the nominal declaration gap only.
    return new TypeAnalyzer(
      {
        entryPoints: [],
        maxShapeProperties: options?.maxShapeProperties,
      },
      program as ts.Program,
    );
  }

  /**
   * Creates a TypeScript program for exported API type analysis.
   * @param options - Entry points, optional tsconfig, and rendering limits.
   * @param existingProgram - When provided, reuses this program instead of creating one.
   */
  public constructor(options: TypeAnalyzerOptions, existingProgram?: ts.Program) {
    this.entryPoints = options.entryPoints.map((entryPoint) => path.resolve(entryPoint));
    this.maxShapeProperties = options.maxShapeProperties ?? DEFAULT_MAX_SHAPE_PROPERTIES;

    if (existingProgram) {
      this.program = existingProgram;
    } else {
      const parsedConfig = options.tsconfigPath ? parseTsConfig(options.tsconfigPath) : undefined;
      this.program = ts.createProgram({
        rootNames: this.entryPoints,
        options: parsedConfig?.options ?? {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: ts.ScriptTarget.ESNext,
        },
      });
    }
    this.checker = this.program.getTypeChecker();
  }

  /**
   * Resolves a public exported type alias by symbol name.
   *
   * Requires at least one configured entrypoint. Use {@link analyzeDeclarationAt}
   * for analyzers created via {@link TypeAnalyzer.fromProgram}.
   * @param symbolName - Exported type alias name.
   * @returns Type alias composition and resolved shape when the symbol exists.
   */
  public analyzeExportedTypeAlias(symbolName: string): TypeAliasAnalysis | undefined {
    if (this.entryPoints.length === 0) {
      throw new Error(
        'analyzeExportedTypeAlias requires configured entryPoints. ' +
          'Use analyzeDeclarationAt for analyzers created via TypeAnalyzer.fromProgram.',
      );
    }

    const declaration = this.findExportedTypeAlias(symbolName);
    if (!declaration) return undefined;

    return this.analyzeTypeAliasDeclaration(declaration);
  }

  /**
   * Locates a type alias or interface declaration by name in a source file and
   * analyzes its composition tree and resolved shape.
   *
   * The file must be part of the analyzer's program (either via entrypoints or
   * through the program provided to {@link TypeAnalyzer.fromProgram}).
   * @param filePath - Absolute path to the source file containing the declaration.
   * @param symbolName - Name of the type alias or interface to analyze.
   * @returns Analysis result, or undefined when no matching declaration is found.
   */
  public analyzeDeclarationAt(filePath: string, symbolName: string): TypeAliasAnalysis | undefined {
    const resolved = path.resolve(filePath);
    const sourceFile = this.program.getSourceFile(resolved);
    if (!sourceFile) return undefined;

    for (const statement of sourceFile.statements) {
      if (ts.isTypeAliasDeclaration(statement) && statement.name.text === symbolName) {
        return this.analyzeTypeAliasDeclaration(statement);
      }
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === symbolName) {
        return this.analyzeInterfaceDeclaration(statement);
      }
    }

    return undefined;
  }

  /**
   * Analyzes a type alias declaration into a composition tree and resolved shape.
   * @param declaration - TypeScript type alias declaration node.
   * @returns Composition and resolved shape analysis.
   */
  private analyzeTypeAliasDeclaration(declaration: ts.TypeAliasDeclaration): TypeAliasAnalysis {
    const symbolName = declaration.name.text;
    const rootSymbol = this.checker.getSymbolAtLocation(declaration.name);
    const expansionPath = rootSymbol ? new Set([this.resolveAlias(rootSymbol)]) : new Set<ts.Symbol>();
    const composition: TypeCompositionNode = {
      text: symbolName,
      symbolName,
      children: [this.analyzeTypeNode(declaration.type, expansionPath)],
    };

    return {
      symbolName,
      composition,
      resolvedShape: this.resolveShape(this.checker.getTypeAtLocation(declaration.name), declaration),
    };
  }

  /**
   * Analyzes an interface declaration into a composition tree and resolved shape.
   *
   * Heritage chains (extends clauses) are rendered as composition children.
   * The resolved shape flattens inherited properties via the checker's
   * `getPropertiesOfType`.
   * @param declaration - TypeScript interface declaration node.
   * @returns Composition and resolved shape analysis.
   */
  private analyzeInterfaceDeclaration(declaration: ts.InterfaceDeclaration): TypeAliasAnalysis {
    const symbolName = declaration.name.text;
    const rootSymbol = this.checker.getSymbolAtLocation(declaration.name);
    const expansionPath = rootSymbol ? new Set([this.resolveAlias(rootSymbol)]) : new Set<ts.Symbol>();
    const children = this.childrenFromDeclaration(declaration, expansionPath);
    const composition: TypeCompositionNode = {
      text: symbolName,
      symbolName,
      children,
    };

    return {
      symbolName,
      composition,
      resolvedShape: this.resolveShape(this.checker.getTypeAtLocation(declaration.name), declaration),
    };
  }

  /**
   * Finds an exported type alias declaration through the configured public entrypoints.
   * @param symbolName - Exported symbol name.
   * @returns Type alias declaration when present.
   */
  private findExportedTypeAlias(symbolName: string): ts.TypeAliasDeclaration | undefined {
    for (const entryPoint of this.entryPoints) {
      const sourceFile = this.program.getSourceFile(entryPoint);
      if (!sourceFile) continue;

      const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) continue;

      const exported = this.checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.getName() === symbolName);
      const resolved = exported ? this.resolveAlias(exported) : undefined;
      const declaration = resolved?.declarations?.find(ts.isTypeAliasDeclaration);
      if (declaration) return declaration;
    }

    return undefined;
  }

  /**
   * Builds a readable type composition tree from a TypeScript type node.
   * @param node - Type node to analyze.
   * @param expansionPath - Local symbols already expanded on the current recursion path.
   * @returns Composition tree node.
   */
  private analyzeTypeNode(node: ts.TypeNode, expansionPath: ReadonlySet<ts.Symbol>): TypeCompositionNode {
    if (ts.isTypeReferenceNode(node)) {
      return this.analyzeTypeReference(node, expansionPath);
    }

    if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
      return {
        text: node.getText(),
        children: node.types.map((child) => this.analyzeTypeNode(child, expansionPath)),
      };
    }

    return { text: node.getText(), children: [] };
  }

  /**
   * Builds a composition node for a type reference, following local declarations.
   * @param node - Type reference node.
   * @param expansionPath - Local symbols already expanded on the current recursion path.
   * @returns Composition tree node.
   */
  private analyzeTypeReference(node: ts.TypeReferenceNode, expansionPath: ReadonlySet<ts.Symbol>): TypeCompositionNode {
    return this.analyzeReferencedTypeExpression(node.getText(), node.typeName, node.typeArguments, expansionPath);
  }

  /**
   * Extracts composition children from a referenced declaration.
   * @param declaration - Referenced local declaration.
   * @param expansionPath - Local symbols already expanded on the current recursion path.
   * @returns Nested composition nodes.
   */
  private childrenFromDeclaration(
    declaration: ts.Declaration,
    expansionPath: ReadonlySet<ts.Symbol>,
  ): TypeCompositionNode[] {
    if (ts.isTypeAliasDeclaration(declaration)) {
      return [this.analyzeTypeNode(declaration.type, expansionPath)];
    }

    if (ts.isInterfaceDeclaration(declaration)) {
      return (declaration.heritageClauses ?? [])
        .flatMap((clause) => clause.types)
        .map((heritageType) => this.analyzeHeritageType(heritageType, expansionPath));
    }

    return [];
  }

  /**
   * Builds a composition node for an interface heritage reference.
   * @param node - Heritage type expression.
   * @param expansionPath - Local symbols already expanded on the current recursion path.
   * @returns Composition tree node.
   */
  private analyzeHeritageType(
    node: ts.ExpressionWithTypeArguments,
    expansionPath: ReadonlySet<ts.Symbol>,
  ): TypeCompositionNode {
    return this.analyzeReferencedTypeExpression(node.getText(), node.expression, node.typeArguments, expansionPath);
  }

  /**
   * Builds a composition node for a local type reference-like expression.
   * @param text - Human-readable type expression text.
   * @param symbolNode - Node whose symbol represents the referenced type.
   * @param typeArguments - Generic type arguments supplied to the reference.
   * @param expansionPath - Local symbols already expanded on the current recursion path.
   * @returns Composition tree node.
   */
  private analyzeReferencedTypeExpression(
    text: string,
    symbolNode: ts.Node,
    typeArguments: readonly ts.TypeNode[] | undefined,
    expansionPath: ReadonlySet<ts.Symbol>,
  ): TypeCompositionNode {
    const referencedSymbol = this.checker.getSymbolAtLocation(symbolNode);
    const resolvedSymbol = referencedSymbol ? this.resolveAlias(referencedSymbol) : undefined;
    const symbolName = resolvedSymbol?.getName();
    const declaration = resolvedSymbol?.declarations?.[0];
    const isLocalDeclaration = declaration ? this.isLocalDeclaration(declaration) : false;
    const children = (typeArguments ?? []).map((typeArgument) => this.analyzeTypeNode(typeArgument, expansionPath));

    if (isLocalDeclaration && declaration && resolvedSymbol && !expansionPath.has(resolvedSymbol)) {
      const childExpansionPath = new Set(expansionPath);
      childExpansionPath.add(resolvedSymbol);
      children.push(...this.childrenFromDeclaration(declaration, childExpansionPath));
    }

    return {
      text,
      symbolName: isLocalDeclaration ? symbolName : undefined,
      children,
    };
  }

  /**
   * Resolves a type to a compact object shape when it is small enough to render.
   * @param type - TypeScript type to inspect.
   * @param location - Node used for contextual type rendering.
   * @returns Resolved object shape or omission reason.
   */
  private resolveShape(type: ts.Type, location: ts.Node): ResolvedTypeShape | undefined {
    const properties = this.checker.getPropertiesOfType(type);
    if (properties.length === 0) return undefined;

    if (properties.length > this.maxShapeProperties) {
      return {
        kind: 'omitted',
        reason: `Resolved shape has ${properties.length} properties, above the ${this.maxShapeProperties} property limit.`,
      };
    }

    return {
      kind: 'object',
      properties: properties.map((property) => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
        return {
          name: property.getName(),
          type: this.checker.typeToString(
            this.checker.getTypeOfSymbolAtLocation(property, declaration),
            declaration,
            TYPE_FORMAT_FLAGS,
          ),
          optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
        };
      }),
    };
  }

  /**
   * Resolves TypeScript alias symbols to their target symbol.
   * @param symbol - Symbol to resolve.
   * @returns Resolved symbol.
   */
  private resolveAlias(symbol: ts.Symbol): ts.Symbol {
    return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  /**
   * Returns whether a declaration belongs to one of the analyzed source files.
   * @param declaration - Declaration to classify.
   * @returns True for non-library declarations in the current program.
   */
  private isLocalDeclaration(declaration: ts.Declaration): boolean {
    const sourcePath = path.resolve(declaration.getSourceFile().fileName);
    return !declaration.getSourceFile().isDeclarationFile && this.program.getSourceFile(sourcePath) !== undefined;
  }
}

/**
 * Parses a TypeScript project configuration file.
 * @param tsconfigPath - Absolute or relative tsconfig path.
 * @returns Parsed TypeScript compiler configuration.
 */
function parseTsConfig(tsconfigPath: string): ts.ParsedCommandLine {
  const resolvedPath = path.resolve(tsconfigPath);
  const config = ts.readConfigFile(resolvedPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }

  return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(resolvedPath));
}

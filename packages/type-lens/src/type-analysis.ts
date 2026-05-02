import path from 'node:path';
import ts from 'typescript';

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

export interface ResolvedTypeProperty {
  /** Property name in the resolved object shape. */
  name: string;
  /** Rendered TypeScript type for the property. */
  type: string;
  /** Whether the property remains optional after type resolution. */
  optional: boolean;
}

export type ResolvedTypeShape =
  | {
      kind: 'object';
      properties: ResolvedTypeProperty[];
    }
  | {
      kind: 'omitted';
      reason: string;
    };

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
 * Compiler-backed analyzer for public TypeScript type aliases.
 */
export class TypeAnalyzer {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly entryPoints: string[];
  private readonly maxShapeProperties: number;

  /**
   * Creates a TypeScript program for exported API type analysis.
   * @param options - Entry points, optional tsconfig, and rendering limits.
   */
  public constructor(options: TypeAnalyzerOptions) {
    this.entryPoints = options.entryPoints.map((entryPoint) => path.resolve(entryPoint));
    this.maxShapeProperties = options.maxShapeProperties ?? DEFAULT_MAX_SHAPE_PROPERTIES;

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
    this.checker = this.program.getTypeChecker();
  }

  /**
   * Resolves a public exported type alias by symbol name.
   * @param symbolName - Exported type alias name.
   * @returns Type alias composition and resolved shape when the symbol exists.
   */
  public analyzeExportedTypeAlias(symbolName: string): TypeAliasAnalysis | undefined {
    const declaration = this.findExportedTypeAlias(symbolName);
    if (!declaration) return undefined;

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
    const referencedSymbol = this.checker.getSymbolAtLocation(node.typeName);
    const resolvedSymbol = referencedSymbol ? this.resolveAlias(referencedSymbol) : undefined;
    const symbolName = resolvedSymbol?.getName();
    const declaration = resolvedSymbol?.declarations?.[0];
    const isLocalDeclaration = declaration ? this.isLocalDeclaration(declaration) : false;
    const children = (node.typeArguments ?? []).map((typeArgument) =>
      this.analyzeTypeNode(typeArgument, expansionPath),
    );

    if (isLocalDeclaration && declaration && resolvedSymbol && !expansionPath.has(resolvedSymbol)) {
      const childExpansionPath = new Set(expansionPath);
      childExpansionPath.add(resolvedSymbol);
      children.push(...this.childrenFromDeclaration(declaration, childExpansionPath));
    }

    return {
      text: node.getText(),
      symbolName: isLocalDeclaration ? symbolName : undefined,
      children,
    };
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
        .map((heritageType) => this.analyzeTypeNode(heritageType, expansionPath));
    }

    return [];
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

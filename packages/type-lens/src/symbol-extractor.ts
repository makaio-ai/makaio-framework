import {
  SyntaxKind,
  type ArrowFunction,
  type ClassDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  type Type,
  type Symbol as TsMorphSymbol,
  type VariableDeclaration,
  type VariableStatement,
} from 'ts-morph';
import type { SymbolNode, SymbolKind } from './schemas.js';
import { generateId } from './symbol-id.js';

/**
 * Top-level variable declaration with a function-like initializer that is
 * indexed as a standalone function symbol.
 */
interface TopLevelFunctionVariableDeclaration {
  /** Variable declaration carrying the function symbol name. */
  readonly declaration: VariableDeclaration;
  /** Arrow/function-expression initializer used for signature extraction. */
  readonly initializer: ArrowFunction | FunctionExpression;
  /** Whether the owning variable statement is exported. */
  readonly isExported: boolean;
}

/**
 * Find the first declaration in a source file matching `name` and optional `kind`.
 *
 * When `kind` is omitted all declaration categories are tried in order:
 * class → interface → function → type alias → enum. Function lookup follows
 * the same declaration forms indexed by {@link extractFunctions}: bodyful
 * `FunctionDeclaration` nodes and top-level variable declarations initialized
 * with an arrow function or function expression.
 * @param sourceFile - Parsed source file
 * @param name - Symbol name
 * @param kind - Optional kind filter
 * @returns Matched declaration node, or null when not found
 */
export function findDeclaration(sourceFile: SourceFile, name: string, kind?: SymbolKind): Node | null {
  if (!kind || kind === 'class') {
    const cls = sourceFile.getClass(name);
    if (cls) return cls;
  }

  if (!kind || kind === 'interface') {
    const iface = sourceFile.getInterface(name);
    if (iface) return iface;
  }

  if (!kind || kind === 'function') {
    const func = findBodyfulFunctionDeclaration(sourceFile, name);
    if (func) return func;

    const variableFunction = findTopLevelFunctionVariableDeclaration(sourceFile, name);
    if (variableFunction) return variableFunction;
  }

  if (!kind || kind === 'type') {
    const typeAlias = sourceFile.getTypeAlias(name);
    if (typeAlias) return typeAlias;
  }

  if (!kind || kind === 'enum') {
    const enumDecl = sourceFile.getEnum(name);
    if (enumDecl) return enumDecl;
  }

  return null;
}

/**
 * Build the inheritance chain for a class declaration.
 *
 * Walks the base-type chain via ts-morph's type resolution until it reaches
 * a type with no declared base or encounters a cycle. Returns null when the
 * named class does not exist in the source file.
 * @param sourceFile - Parsed source file
 * @param name - Class name
 * @returns Chain starting with `name`, or null if the class is not found
 */
export function getClassHierarchy(sourceFile: SourceFile, name: string): string[] | null {
  const cls = sourceFile.getClass(name);
  if (!cls) return null;

  const chain: string[] = [name];
  let current: ClassDeclaration | undefined = cls;

  while (current) {
    const baseType: Type | undefined = current.getBaseTypes()[0];
    if (!baseType) break;

    const baseSymbol: TsMorphSymbol | undefined = baseType.getSymbol();
    const baseName = baseSymbol?.getName() ?? baseType.getText();
    if (!baseName || chain.includes(baseName)) break;

    chain.push(baseName);

    const baseDeclaration: ClassDeclaration | undefined = baseSymbol
      ?.getDeclarations()
      ?.find((decl: Node): decl is ClassDeclaration => decl.getKind() === SyntaxKind.ClassDeclaration);
    if (!baseDeclaration) break;
    current = baseDeclaration;
  }

  return chain;
}

/**
 * Build the extends chain for an interface declaration.
 *
 * Only the direct `extends` clause is walked — transitive bases are not
 * followed. Returns null when the named interface does not exist in the
 * source file.
 * @param sourceFile - Parsed source file
 * @param name - Interface name
 * @returns Chain starting with `name`, or null if not found
 */
export function getInterfaceHierarchy(sourceFile: SourceFile, name: string): string[] | null {
  const iface = sourceFile.getInterface(name);
  if (!iface) return null;

  const chain: string[] = [name];
  for (const ext of iface.getExtends()) {
    const text = ext.getText();
    if (text) chain.push(text);
  }

  return chain;
}

/**
 * Extract class symbol nodes from a source file.
 * @param sourceFile - Parsed source file
 * @param relPath - Relative path used as the `file` field on each symbol
 * @returns Array of class symbol nodes
 */
export function extractClasses(sourceFile: SourceFile, relPath: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name) continue;

    const heritage = cls.getHeritageClauses();
    const extendsClause = heritage.find((h) => h.getToken() === SyntaxKind.ExtendsKeyword);
    const implementsClause = heritage.find((h) => h.getToken() === SyntaxKind.ImplementsKeyword);

    let signature = `class ${name}`;
    if (extendsClause) {
      signature += ` extends ${extendsClause
        .getTypeNodes()
        .map((t) => t.getText())
        .join(', ')}`;
    }
    if (implementsClause) {
      signature += ` implements ${implementsClause
        .getTypeNodes()
        .map((t) => t.getText())
        .join(', ')}`;
    }

    symbols.push({
      id: generateId(relPath, '', name, 'class'),
      name,
      kind: 'class',
      file: relPath,
      line: cls.getStartLineNumber(),
      isExported: cls.isExported(),
      signature,
    });
  }

  return symbols;
}

/**
 * Extract interface symbol nodes from a source file.
 * @param sourceFile - Parsed source file
 * @param relPath - Relative path used as the `file` field on each symbol
 * @returns Array of interface symbol nodes
 */
export function extractInterfaces(sourceFile: SourceFile, relPath: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  for (const iface of sourceFile.getInterfaces()) {
    const name = iface.getName();
    const extendsTypes = iface.getExtends();

    let signature = `interface ${name}`;
    if (extendsTypes.length > 0) {
      signature += ` extends ${extendsTypes.map((t) => t.getText()).join(', ')}`;
    }

    symbols.push({
      id: generateId(relPath, '', name, 'interface'),
      name,
      kind: 'interface',
      file: relPath,
      line: iface.getStartLineNumber(),
      isExported: iface.isExported(),
      signature,
    });
  }

  return symbols;
}

/**
 * Build a parenthesised parameter list string from an array of parameter declarations.
 * @param params - ts-morph parameter declarations
 * @returns Formatted parameter list, e.g. `(a: string, b: number)`
 */
function formatParamList(params: ParameterDeclaration[]): string {
  return `(${params.map((p) => `${p.getName()}: ${p.getType().getText()}`).join(', ')})`;
}

/**
 * Find the indexed implementation declaration for a top-level function.
 * @param sourceFile - Parsed source file
 * @param name - Function name to locate
 * @returns Function declaration with a body, or undefined when not found
 */
function findBodyfulFunctionDeclaration(sourceFile: SourceFile, name: string): FunctionDeclaration | undefined {
  return sourceFile.getFunctions().find((func) => func.getName() === name && func.getBody() !== undefined);
}

/**
 * Narrow an initializer to the function-like forms indexed as standalone functions.
 * @param initializer - Variable initializer candidate
 * @returns Function-like initializer, or undefined for non-function values
 */
function asFunctionLikeInitializer(initializer: Node | undefined): ArrowFunction | FunctionExpression | undefined {
  const kind = initializer?.getKind();
  return kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression
    ? (initializer as ArrowFunction | FunctionExpression)
    : undefined;
}

/**
 * Check whether a variable statement is indexed as a file-level function owner.
 * @param statement - Variable statement to inspect
 * @param sourceFile - Source file that owns indexed top-level statements
 * @returns True when the statement is directly owned by the source file
 */
function isTopLevelVariableStatement(statement: VariableStatement, sourceFile: SourceFile): boolean {
  return statement.getParent() === sourceFile;
}

/**
 * Iterate top-level variable declarations indexed as standalone functions.
 * @param sourceFile - Parsed source file
 * @returns Function variable declarations with their function-like initializer and export state
 */
function* getTopLevelFunctionVariableDeclarations(
  sourceFile: SourceFile,
): Iterable<TopLevelFunctionVariableDeclaration> {
  for (const statement of sourceFile.getVariableStatements()) {
    if (!isTopLevelVariableStatement(statement, sourceFile)) continue;

    const isExported = statement.isExported();

    for (const declaration of statement.getDeclarations()) {
      const initializer = asFunctionLikeInitializer(declaration.getInitializer());
      if (!initializer) continue;

      yield { declaration, initializer, isExported };
    }
  }
}

/**
 * Find a top-level variable declaration indexed as a standalone function.
 * @param sourceFile - Parsed source file
 * @param name - Variable name to locate
 * @returns Top-level variable with an arrow/function-expression initializer, or undefined
 */
function findTopLevelFunctionVariableDeclaration(
  sourceFile: SourceFile,
  name: string,
): VariableDeclaration | undefined {
  for (const { declaration } of getTopLevelFunctionVariableDeclarations(sourceFile)) {
    if (declaration.getName() === name) {
      return declaration;
    }
  }

  return undefined;
}

/**
 * Create the canonical symbol node shape for an indexed function.
 * @param relPath - Relative file path for the symbol
 * @param name - Function symbol name
 * @param line - 1-based source line
 * @param isExported - Whether the declaration is exported
 * @param signature - Display signature for the function
 * @returns Function symbol node
 */
function createFunctionSymbolNode(
  relPath: string,
  name: string,
  line: number,
  isExported: boolean,
  signature: string,
): SymbolNode {
  return {
    id: generateId(relPath, '', name, 'function'),
    name,
    kind: 'function',
    file: relPath,
    line,
    isExported,
    signature,
  };
}

/**
 * Extract function symbol nodes from a source file.
 *
 * Indexes both `FunctionDeclaration` nodes and top-level variable declarations
 * whose initializer is an `ArrowFunction` or `FunctionExpression`.
 * @param sourceFile - Parsed source file
 * @param relPath - Relative path used as the `file` field on each symbol
 * @returns Array of function symbol nodes
 */
export function extractFunctions(sourceFile: SourceFile, relPath: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  // --- Standard function declarations ---
  for (const func of sourceFile.getFunctions()) {
    // Skip bodyless overload stubs — only index the implementation declaration
    if (func.getBody() === undefined) continue;

    const name = func.getName();
    if (!name) continue;

    const paramList = formatParamList(func.getParameters());
    const returnType = func.getReturnType().getText();

    symbols.push(
      createFunctionSymbolNode(
        relPath,
        name,
        func.getStartLineNumber(),
        func.isExported(),
        `function ${name}${paramList}: ${returnType}`,
      ),
    );
  }

  // --- Variable-declared arrow functions and function expressions ---
  for (const { declaration, initializer, isExported } of getTopLevelFunctionVariableDeclarations(sourceFile)) {
    const name = declaration.getName();
    const paramList = formatParamList(initializer.getParameters());
    const returnType = initializer.getReturnType().getText();

    symbols.push(
      createFunctionSymbolNode(
        relPath,
        name,
        declaration.getStartLineNumber(),
        isExported,
        `${name}${paramList}: ${returnType}`,
      ),
    );
  }

  return symbols;
}

/**
 * Extract type-alias symbol nodes from a source file.
 * @param sourceFile - Parsed source file
 * @param relPath - Relative path used as the `file` field on each symbol
 * @returns Array of type-alias symbol nodes
 */
export function extractTypeAliases(sourceFile: SourceFile, relPath: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  for (const typeAlias of sourceFile.getTypeAliases()) {
    const name = typeAlias.getName();

    symbols.push({
      id: generateId(relPath, '', name, 'type'),
      name,
      kind: 'type',
      file: relPath,
      line: typeAlias.getStartLineNumber(),
      isExported: typeAlias.isExported(),
      signature: `type ${name} = ${typeAlias.getTypeNode()?.getText() ?? 'unknown'}`,
    });
  }

  return symbols;
}

/**
 * Extract enum symbol nodes from a source file.
 * @param sourceFile - Parsed source file
 * @param relPath - Relative path used as the `file` field on each symbol
 * @returns Array of enum symbol nodes
 */
export function extractEnums(sourceFile: SourceFile, relPath: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  for (const enumDecl of sourceFile.getEnums()) {
    const name = enumDecl.getName();

    symbols.push({
      id: generateId(relPath, '', name, 'enum'),
      name,
      kind: 'enum',
      file: relPath,
      line: enumDecl.getStartLineNumber(),
      isExported: enumDecl.isExported(),
      signature: `enum ${name}`,
    });
  }

  return symbols;
}

/**
 * Locate the AST node for a method, arrow property, or standalone function.
 *
 * For class members: tries `MethodDeclaration` first, then falls back to an
 * arrow-function or function-expression `PropertyDeclaration`.
 * For standalone functions: tries `FunctionDeclaration` first, then a
 * variable declaration whose initializer is an arrow or function expression.
 * @param sourceFile - Parsed source file
 * @param className - Containing class name, or null for standalone functions
 * @param methodName - Method or function name
 * @returns The matching node, or undefined when not found
 */
export function findMethodNode(sourceFile: SourceFile, className: string | null, methodName: string): Node | undefined {
  if (className !== null) {
    // getClass() resolves top-level class declarations only. TypeScript has
    // no nested-class syntax. parseMethodTarget rejects dotted class segments
    // (e.g. "Outer.Inner") before they reach here, so className is always a
    // simple, flat identifier at this call site.
    const cls = sourceFile.getClass(className);
    if (!cls) return undefined;

    const method = cls.getMethod(methodName);
    if (method) return method;

    const prop = cls.getProperty(methodName);
    if (prop) {
      const initializer = prop.getInitializer();
      if (
        initializer &&
        (initializer.getKind() === SyntaxKind.ArrowFunction || initializer.getKind() === SyntaxKind.FunctionExpression)
      ) {
        return prop;
      }
    }
    return undefined;
  }

  // Function overloads can include bodyless stubs. Prefer the implementation
  // declaration so standalone function lookup matches extraction.
  const fn = findBodyfulFunctionDeclaration(sourceFile, methodName);
  if (fn) return fn;

  const variable = findTopLevelFunctionVariableDeclaration(sourceFile, methodName);
  if (variable) {
    return variable;
  }

  return undefined;
}

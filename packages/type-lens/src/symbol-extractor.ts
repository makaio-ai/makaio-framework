import {
  SyntaxKind,
  type ClassDeclaration,
  type Node,
  type SourceFile,
  type Type,
  type Symbol as TsMorphSymbol,
} from 'ts-morph';
import type { SymbolNode, SymbolKind } from './schemas.js';
import { generateId } from './symbol-id.js';

/**
 * Find the first declaration in a source file matching `name` and optional `kind`.
 *
 * When `kind` is omitted all declaration categories are tried in order:
 * class → interface → function → type alias → enum.
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
    const func = sourceFile.getFunction(name);
    if (func) return func;
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
 * Extract function symbol nodes from a source file.
 * @param sourceFile - Parsed source file
 * @param relPath - Relative path used as the `file` field on each symbol
 * @returns Array of function symbol nodes
 */
export function extractFunctions(sourceFile: SourceFile, relPath: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  for (const func of sourceFile.getFunctions()) {
    // Skip bodyless overload stubs — only index the implementation declaration
    if (func.getBody() === undefined) continue;

    const name = func.getName();
    if (!name) continue;

    const params = func.getParameters().map((p) => `${p.getName()}: ${p.getType().getText()}`);
    const returnType = func.getReturnType().getText();

    symbols.push({
      id: generateId(relPath, '', name, 'function'),
      name,
      kind: 'function',
      file: relPath,
      line: func.getStartLineNumber(),
      isExported: func.isExported(),
      signature: `function ${name}(${params.join(', ')}): ${returnType}`,
    });
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

  // getFunction() returns the first declaration which may be a bodyless overload stub.
  // Prefer the implementation declaration (the one with a body) to avoid returning a stub.
  const fn = sourceFile.getFunctions().find((f) => f.getName() === methodName && f.getBody() !== undefined);
  if (fn) return fn;

  const variable = sourceFile.getVariableDeclaration(methodName);
  const initializer = variable?.getInitializer();
  if (
    variable &&
    initializer &&
    (initializer.getKind() === SyntaxKind.ArrowFunction || initializer.getKind() === SyntaxKind.FunctionExpression)
  ) {
    return variable;
  }

  return undefined;
}

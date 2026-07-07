import type { SourceFile, ClassDeclaration, InterfaceDeclaration, JSDocableNode, PropertyDeclaration } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import type { MemberInfo, SymbolKind, SymbolNode } from './schemas.js';
import { generateId } from './symbol-id.js';
import { findDeclaration as findIndexedDeclaration } from './symbol-extractor.js';

/**
 * Type guard to check if a Node is a ClassDeclaration or InterfaceDeclaration.
 * @param node - The ts-morph Node to check
 * @returns True if the node is a class or interface declaration
 */
function isMemberContainer(node: Node): node is ClassDeclaration | InterfaceDeclaration {
  return Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node);
}

/**
 * Find a declaration node by name and kind.
 * @param sourceFile - The ts-morph source file
 * @param name - Symbol name
 * @param kind - Symbol kind
 * @returns Declaration node or undefined
 */
export function findDeclaration(sourceFile: SourceFile, name: string, kind: SymbolKind): Node | undefined {
  switch (kind) {
    case 'class':
      return sourceFile.getClass(name);
    case 'interface':
      return sourceFile.getInterface(name);
    case 'function':
      return findIndexedDeclaration(sourceFile, name, kind) ?? undefined;
    case 'type':
      return sourceFile.getTypeAlias(name);
    case 'enum':
      return sourceFile.getEnum(name);
    case 'method':
      // Method symbols need their containing class namespace, so callers resolve
      // them through method-specific helpers rather than this top-level lookup.
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Extract members from a class or interface.
 * @param sourceFile - The source file
 * @param name - Symbol name
 * @param kind - Symbol kind
 * @returns Array of members
 */
export function extractMembers(sourceFile: SourceFile, name: string, kind: SymbolKind): MemberInfo[] {
  if (kind !== 'class' && kind !== 'interface') return [];

  const node = findDeclaration(sourceFile, name, kind);
  if (!node || !isMemberContainer(node)) return [];

  const members: MemberInfo[] = [];

  for (const prop of node.getProperties()) {
    members.push({
      name: prop.getName(),
      type: prop.getType().getText(),
      line: prop.getStartLineNumber(),
    });
  }

  for (const method of node.getMethods()) {
    const params = method.getParameters().map((p) => `${p.getName()}: ${p.getType().getText()}`);
    members.push({
      name: method.getName(),
      type: `(${params.join(', ')}) => ${method.getReturnType().getText()}`,
      line: method.getStartLineNumber(),
    });
  }

  return members;
}

/**
 * Extracts executable class members as indexable SymbolNode entries.
 * Emits method symbols for:
 * - MethodDeclaration nodes (skipping bodyless overload stubs)
 * - PropertyDeclaration nodes whose initializer is an ArrowFunction or FunctionExpression
 *
 * Abstract methods and bodyless overload stubs are excluded.
 * `isExported` is always `false` for method symbols — methods are not independently exported.
 *
 * `namespacePath` is set to the class name. Nested ownership (e.g., `Outer.Inner`)
 * is deferred until real TypeScript nested-class syntax exists — see design doc.
 * @param classDeclaration - The class declaration to extract from
 * @param relativeFilePath - Relative file path for the symbol
 * @returns Array of SymbolNode entries with kind='method' and namespacePath set
 */
export function extractExecutableMembers(classDeclaration: ClassDeclaration, relativeFilePath: string): SymbolNode[] {
  const className = classDeclaration.getName();
  if (!className) return [];

  const symbols: SymbolNode[] = [];

  for (const method of classDeclaration.getMethods()) {
    // Skip bodyless overload stubs
    if (method.getBody() === undefined) continue;

    const name = method.getName();
    const params = method.getParameters().map((p) => `${p.getName()}: ${p.getType().getText()}`);
    const returnType = method.getReturnType().getText();

    symbols.push({
      id: generateId(relativeFilePath, className, name, 'method'),
      name,
      kind: 'method',
      file: relativeFilePath,
      line: method.getStartLineNumber(),
      isExported: false,
      namespacePath: className,
      signature: `${name}(${params.join(', ')}): ${returnType}`,
    });
  }

  for (const prop of classDeclaration.getProperties()) {
    const fnNode = getExecutablePropertyInitializer(prop);
    if (!fnNode) continue;

    const name = prop.getName();
    const params = fnNode.getParameters().map((p) => `${p.getName()}: ${p.getType().getText()}`);
    const returnType = fnNode.getReturnType().getText();

    symbols.push({
      id: generateId(relativeFilePath, className, name, 'method'),
      name,
      kind: 'method',
      file: relativeFilePath,
      line: prop.getStartLineNumber(),
      isExported: false,
      namespacePath: className,
      signature: `${name}(${params.join(', ')}): ${returnType}`,
    });
  }

  return symbols;
}

/**
 * Extract JSDoc summary from a symbol.
 * @param sourceFile - The source file
 * @param name - Symbol name
 * @param kind - Symbol kind
 * @param namespacePath - Containing class/namespace for method symbols.
 * @returns JSDoc description or undefined
 */
export function extractDocSummary(
  sourceFile: SourceFile,
  name: string,
  kind: SymbolKind,
  namespacePath?: string | null,
): string | undefined {
  const docNode =
    kind === 'method'
      ? findMethodDocNode(sourceFile, namespacePath ?? null, name)
      : findDocNode(findDeclaration(sourceFile, name, kind));
  if (!docNode) return undefined;

  const jsDocs = docNode.getJsDocs();
  if (jsDocs.length === 0) return undefined;

  const description = jsDocs[0].getDescription?.();
  if (!description) return undefined;

  return (
    description
      .trim()
      .replace(/\n\s*\n/g, '\n')
      .slice(0, 500) || undefined
  );
}

/**
 * Locate the node that owns JSDoc for a declaration.
 *
 * Variable-declared functions are indexed by their {@link SyntaxKind.VariableDeclaration},
 * but JSDoc belongs to the owning variable statement.
 * @param node - Declaration resolved for the symbol.
 * @returns JSDocable node, or undefined when the symbol has no supported doc owner.
 */
function findDocNode(node: Node | undefined): JSDocableNode | undefined {
  if (!node) return undefined;
  if (Node.isJSDocable(node)) return node;

  if (node.getKind() !== SyntaxKind.VariableDeclaration) return undefined;
  const statement = node.getParent()?.getParent();
  return statement && Node.isJSDocable(statement) ? statement : undefined;
}

/**
 * Locate the JSDoc owner for an indexed class method symbol.
 * @param sourceFile - Source file containing the class.
 * @param className - Containing class name from the symbol namespace.
 * @param methodName - Method symbol name.
 * @returns JSDocable method/property node, or undefined when no indexed member matches.
 */
function findMethodDocNode(
  sourceFile: SourceFile,
  className: string | null,
  methodName: string,
): JSDocableNode | undefined {
  if (!className) return undefined;
  const classDeclaration = sourceFile.getClass(className);
  if (!classDeclaration) return undefined;

  const method = classDeclaration
    .getMethods()
    .find((candidate) => candidate.getName() === methodName && candidate.getBody() !== undefined);
  if (method && Node.isJSDocable(method)) return method;

  const property = classDeclaration.getProperties().find((candidate) => {
    if (candidate.getName() !== methodName) return false;
    return getExecutablePropertyInitializer(candidate) !== undefined;
  });

  return property && Node.isJSDocable(property) ? property : undefined;
}

/**
 * Resolve the initializer that makes a class property indexable as an executable method.
 * @param property - Class property to inspect.
 * @returns Arrow/function-expression initializer, or undefined for non-executable properties.
 */
function getExecutablePropertyInitializer(property: PropertyDeclaration) {
  return (
    property.getInitializerIfKind(SyntaxKind.ArrowFunction) ??
    property.getInitializerIfKind(SyntaxKind.FunctionExpression)
  );
}

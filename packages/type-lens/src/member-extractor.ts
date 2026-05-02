import type { SourceFile, ClassDeclaration, InterfaceDeclaration } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import type { MemberInfo, SymbolKind, SymbolNode } from './schemas.js';
import { generateId } from './symbol-id.js';

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
      return sourceFile.getFunction(name);
    case 'type':
      return sourceFile.getTypeAlias(name);
    case 'enum':
      return sourceFile.getEnum(name);
    case 'method':
      // Method symbols are resolved via extractMethodBody(), not findDeclaration().
      // This returns undefined so callers like findSymbolPosition() and extractDocSummary()
      // gracefully return null/undefined for method-kind queries.
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
    const initializer = prop.getInitializer();
    if (
      !initializer ||
      (initializer.getKind() !== SyntaxKind.ArrowFunction && initializer.getKind() !== SyntaxKind.FunctionExpression)
    ) {
      continue;
    }

    const name = prop.getName();
    const fnNode = initializer.asKind(SyntaxKind.ArrowFunction) ?? initializer.asKind(SyntaxKind.FunctionExpression);
    // fnNode is guaranteed non-null here: the enclosing if-guard already
    // checked that the initializer kind is ArrowFunction or FunctionExpression.
    if (!fnNode) continue;

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
 * @returns JSDoc description or undefined
 */
export function extractDocSummary(sourceFile: SourceFile, name: string, kind: SymbolKind): string | undefined {
  const node = findDeclaration(sourceFile, name, kind);
  if (!node) return undefined;

  // Use ts-morph's built-in type guard instead of unsafe cast
  if (!Node.isJSDocable(node)) return undefined;

  const jsDocs = node.getJsDocs();
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

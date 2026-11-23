/**
 * @fileoverview A call context belongs to one operation: refuse fields and module variables that hold one.
 * The rule is lexical, without type information: a value counts as a call context when it is an expression ending in
 * `.call`, the result of `.own(...)`, or a variable or parameter annotated `CallContext`.
 */

/**
 * Holder types that belong to exactly one operation. A `readonly call` field in one of them may carry the call of that
 * operation; every other field holding a call, and a mutable `call` field in a holder, stays an error.
 */
const HOLDER_TYPES = new Set(['MessageHandle', 'ProceduralTurnConfig']);

/** The only field name a holder type may use for its operation's call context. */
const HOLDER_FIELD = 'call';

/**
 * Read the name a member property or class key is written with.
 * @param {import('estree').Node} node - Key or property node.
 * @param {boolean} computed - Whether it was written in brackets.
 * @returns {string | null} The name, or null when it is not static.
 * @example keyName(node.key, node.computed)
 */
function keyName(node, computed) {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * Whether a type node names `CallContext`, alone or as a member of a union (`CallContext | undefined`).
 * @param {import('estree').Node | null | undefined} type - A type node.
 * @returns {boolean} True for `CallContext`, `ns.CallContext` and unions containing one.
 * @example isCallContextType(annotation.typeAnnotation)
 */
function isCallContextType(type) {
  if (!type) return false;
  if (type.type === 'TSUnionType') return type.types.some(isCallContextType);
  if (type.type !== 'TSTypeReference') return false;
  const name = type.typeName;
  if (name.type === 'Identifier') return name.name === 'CallContext';
  return name.type === 'TSQualifiedName' && name.right.name === 'CallContext';
}

/**
 * Whether a type annotation names `CallContext`.
 * @param {import('estree').Node | null | undefined} annotation - A `TSTypeAnnotation` wrapper or null.
 * @returns {boolean} True when the annotated type is or contains `CallContext`.
 * @example isCallContextAnnotation(node.typeAnnotation)
 */
function isCallContextAnnotation(annotation) {
  return isCallContextType(annotation?.typeAnnotation);
}

/**
 * Strip wrappers that do not change the value: `as`, `satisfies`, `!`, `<T>x` and optional chains.
 * @param {import('estree').Node} node - Expression.
 * @returns {import('estree').Node} The wrapped expression.
 * @example unwrap(node.right)
 */
function unwrap(node) {
  let current = node;
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSTypeAssertion' ||
    current.type === 'ChainExpression'
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Whether a node is a class (declaration or expression) or interface that names a holder type.
 * @param {import('estree').Node | null | undefined} node - Candidate.
 * @returns {boolean} True when its name is on the holder list.
 * @example isHolder(enclosingType)
 */
function isHolder(node) {
  return Boolean(node?.id && node.id.type === 'Identifier' && HOLDER_TYPES.has(node.id.name));
}

/**
 * Find the class or interface a member node sits in.
 * @param {import('estree').Node} node - Member node.
 * @returns {import('estree').Node | null} The enclosing class or interface, or null.
 * @example enclosingType(node)
 */
function enclosingType(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === 'ClassDeclaration' ||
      current.type === 'ClassExpression' ||
      current.type === 'TSInterfaceDeclaration'
    ) {
      return current;
    }
    // A member of a nested function or object does not belong to an outer type.
    if (current.type === 'Program') return null;
  }
  return null;
}

/**
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Refuse fields and module variables that hold a call context; a call belongs to the one operation it was handed to',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      heldCall:
        'Do not hold a call context in {{where}}; it belongs to one operation. Pass `call` as the first parameter instead.',
      holderNotReadonly: '{{type}} may carry the call of its one operation only as a `readonly call` field.',
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.sourceCode;

    /**
     * Look up the variable an identifier refers to, walking out through the enclosing scopes.
     * @param {import('estree').Identifier} identifier - The identifier.
     * @returns {import('eslint').Scope.Variable | null} The variable, or null when it is a global or unknown.
     * @example resolveVariable(node)
     */
    function resolveVariable(identifier) {
      for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
      }
      return null;
    }

    /**
     * Whether a variable is declared at module level (module or global scope).
     * @param {import('eslint').Scope.Variable | null} variable - Resolved variable.
     * @returns {boolean} True for module-level variables.
     * @example isModuleLevel(variable)
     */
    function isModuleLevel(variable) {
      return Boolean(variable) && (variable.scope.type === 'module' || variable.scope.type === 'global');
    }

    /**
     * Whether an expression lexically is a call context.
     * @param {import('estree').Node | null | undefined} expression - Expression to test.
     * @returns {boolean} True for `<x>.call`, `<x>.own(...)`, and identifiers annotated `CallContext`.
     * @example isCallValue(node.value)
     */
    function isCallValue(expression) {
      if (!expression) return false;
      const node = unwrap(expression);
      switch (node.type) {
        case 'MemberExpression':
          return keyName(node.property, node.computed) === 'call';
        case 'CallExpression': {
          const callee = unwrap(node.callee);
          return callee.type === 'MemberExpression' && keyName(callee.property, callee.computed) === 'own';
        }
        case 'Identifier': {
          const variable = resolveVariable(node);
          return Boolean(variable?.defs.some((definition) => isCallContextAnnotation(definition.name.typeAnnotation)));
        }
        case 'ConditionalExpression':
          return isCallValue(node.consequent) || isCallValue(node.alternate);
        case 'LogicalExpression':
          return isCallValue(node.left) || isCallValue(node.right);
        case 'AwaitExpression':
          return isCallValue(node.argument);
        default:
          return false;
      }
    }

    /**
     * Check one declared member (class field, parameter property, interface property) that holds or is typed as a
     * call context, against the holder exception.
     * @param {import('estree').Node} node - Member node to report on.
     * @param {import('estree').Node} owner - Class or interface the member sits in.
     * @param {string | null} name - The member's name.
     * @param {boolean} readonly - Whether the member is `readonly`.
     * @example checkMember(node, owner, 'call', true)
     */
    function checkMember(node, owner, name, readonly) {
      if (!isHolder(owner)) {
        context.report({ node, messageId: 'heldCall', data: { where: 'a field' } });
      } else if (name !== HOLDER_FIELD || !readonly) {
        context.report({ node, messageId: 'holderNotReadonly', data: { type: owner.id.name } });
      }
    }

    /**
     * Check a class field, accessor property or abstract property.
     * @param {import('estree').Node} node - Property definition.
     * @example checkClassField(node)
     */
    function checkClassField(node) {
      if (!isCallContextAnnotation(node.typeAnnotation) && !isCallValue(node.value)) return;
      const owner = enclosingType(node);
      if (!owner) return;
      checkMember(node, owner, keyName(node.key, node.computed), node.readonly === true);
    }

    /**
     * Check a module-level variable declarator.
     * @param {import('estree').Node} node - Variable declarator.
     * @example checkModuleDeclarator(node)
     */
    function checkModuleDeclarator(node) {
      const declaration = node.parent;
      const container = declaration?.parent;
      const atModule =
        container?.type === 'Program' ||
        (container?.type === 'ExportNamedDeclaration' && container.parent?.type === 'Program');
      if (!atModule) return;
      if (isCallContextAnnotation(node.id.typeAnnotation) || isCallValue(node.init)) {
        context.report({ node, messageId: 'heldCall', data: { where: 'a module variable' } });
      }
    }

    return {
      PropertyDefinition: checkClassField,
      AccessorProperty: checkClassField,
      TSAbstractPropertyDefinition: checkClassField,

      TSParameterProperty(node) {
        const parameter = node.parameter.type === 'AssignmentPattern' ? node.parameter.left : node.parameter;
        if (!isCallContextAnnotation(parameter.typeAnnotation)) return;
        const owner = enclosingType(node);
        if (!owner) return;
        checkMember(node, owner, parameter.type === 'Identifier' ? parameter.name : null, node.readonly === true);
      },

      TSPropertySignature(node) {
        const owner = node.parent?.parent;
        if (owner?.type !== 'TSInterfaceDeclaration' || !isHolder(owner)) return;
        if (!isCallContextAnnotation(node.typeAnnotation)) return;
        checkMember(node, owner, keyName(node.key, node.computed), node.readonly === true);
      },

      VariableDeclarator: checkModuleDeclarator,

      AssignmentExpression(node) {
        if (node.operator !== '=' || !isCallValue(node.right)) return;
        const left = unwrap(node.left);
        if (left.type === 'Identifier') {
          if (isModuleLevel(resolveVariable(left))) {
            context.report({ node, messageId: 'heldCall', data: { where: 'a module variable' } });
          }
          return;
        }
        if (left.type !== 'MemberExpression' || left.object.type !== 'ThisExpression') return;
        const owner = enclosingType(node);
        // A holder's constructor may fill its `call` field; the field declaration itself carries the readonly check.
        if (isHolder(owner) && keyName(left.property, left.computed) === HOLDER_FIELD) return;
        context.report({ node, messageId: 'heldCall', data: { where: 'a field' } });
      },
    };
  },
};

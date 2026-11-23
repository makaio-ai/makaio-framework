/**
 * @fileoverview Keep `own` a plain method call: `<expression>.own('<purpose>')` is the one way to acquire an own call context.
 */

/** The method name of the one acquisition syntax. */
const OWN = 'own';

/**
 * Read the name a member property or object-pattern key is written with.
 * @param {import('estree').Node} node - Identifier or string literal.
 * @param {boolean} computed - Whether it was written in brackets.
 * @returns {string | null} The name, or null when it is not static.
 * @example staticName(node.property, node.computed)
 */
function staticName(node, computed) {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? null;
  }
  return null;
}

/**
 * Whether a member expression is the callee of the call that wraps it (`a.own(...)`, `a?.own(...)`).
 * @param {import('estree').MemberExpression & { parent: import('estree').Node }} node - Member expression.
 * @returns {boolean} True when the parent call uses the member as its callee.
 * @example isCallee(node)
 */
function isCallee(node) {
  return node.parent.type === 'CallExpression' && node.parent.callee === node;
}

/**
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Allow `own` only as a direct method call with a string literal purpose: no alias, no destructuring, no bracket access, no escaped spelling',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      ownAlias:
        "`own` is only allowed as a direct method call `<expression>.own('<purpose>')`; {{what}} hides the acquisition of an own call context.",
      ownPurpose: "`own` takes exactly one string literal purpose, for example `bus.own('observer')`.",
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.sourceCode;

    return {
      MemberExpression(node) {
        if (staticName(node.property, node.computed) !== OWN) return;

        if (node.computed) {
          context.report({ node, messageId: 'ownAlias', data: { what: 'bracket access' } });
          return;
        }
        if (sourceCode.getText(node.property) !== OWN) {
          context.report({ node, messageId: 'ownAlias', data: { what: 'an escaped spelling of the name' } });
          return;
        }
        if (!isCallee(node)) {
          context.report({ node, messageId: 'ownAlias', data: { what: 'a reference that is not called directly' } });
          return;
        }

        const { arguments: args } = node.parent;
        const [purpose] = args;
        const isLiteralPurpose = args.length === 1 && purpose.type === 'Literal' && typeof purpose.value === 'string';
        if (!isLiteralPurpose) context.report({ node: node.parent, messageId: 'ownPurpose' });
      },

      // `const { own } = bus` and `const { own: acquire } = bus`
      'ObjectPattern > Property'(node) {
        if (staticName(node.key, node.computed) === OWN) {
          context.report({ node, messageId: 'ownAlias', data: { what: 'destructuring' } });
        }
      },
    };
  },
};

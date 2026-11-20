/**
 * @fileoverview Keep process starts behind the launcher: refuse the modules and Bun APIs that start a process.
 */

/** Module names that start an operating-system process. */
const PROCESS_START_MODULES = new Set(['node:child_process', 'child_process', 'execa', 'node-pty']);

/** `Bun` members that start a process. */
const BUN_PROCESS_MEMBERS = new Set(['spawn', 'spawnSync', '$']);

/**
 * Read the static string of a module specifier node.
 * @param {import('estree').Node | null | undefined} node - Specifier expression.
 * @returns {string | null} The string, or null when it is not statically known.
 * @example staticString(node.source)
 */
function staticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? null;
  }
  return null;
}

/**
 * Read the name a callee or member property is written with.
 * @param {import('estree').Node} node - Identifier or string literal.
 * @param {boolean} computed - Whether it was written in brackets.
 * @returns {string | null} The name, or null when it is not static.
 * @example propertyName(node.property, node.computed)
 */
function propertyName(node, computed) {
  if (!computed && node.type === 'Identifier') return node.name;
  if (computed) return staticString(node);
  return null;
}

/**
 * Whether a node names the `Bun` global, directly or as `globalThis.Bun`.
 * @param {import('estree').Node} node - Candidate object of a member access.
 * @returns {boolean} True for `Bun` and `globalThis.Bun`.
 * @example isBunGlobal(node.object)
 */
function isBunGlobal(node) {
  if (node.type === 'Identifier') return node.name === 'Bun';
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.object.name === 'globalThis' &&
    propertyName(node.property, node.computed) === 'Bun'
  );
}

/**
 * Whether a call is `createRequire(...)`, bare or as a member (`module.createRequire(...)`).
 * @param {import('estree').Node | null | undefined} node - Candidate call.
 * @returns {boolean} True for a `createRequire` call.
 * @example isCreateRequireCall(declarator.init)
 */
function isCreateRequireCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name === 'createRequire';
  return callee.type === 'MemberExpression' && propertyName(callee.property, callee.computed) === 'createRequire';
}

/**
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Refuse process-starting modules (static import, re-export, import(), require) and Bun process APIs outside the launcher',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      directProcessStart:
        'Start processes through launch from @makaio/subprocess; {{what}} is reserved for the launcher.',
    },
    schema: [],
  },

  create(context) {
    /** Names bound to a `createRequire(...)` result in this file. */
    const requireFunctions = new Set();

    /**
     * Report when a module specifier names a process-starting module.
     * @param {import('estree').Node} reportNode - Node to report on.
     * @param {import('estree').Node | null | undefined} sourceNode - The module specifier.
     * @example checkModule(node, node.source)
     */
    function checkModule(reportNode, sourceNode) {
      const name = staticString(sourceNode);
      if (name !== null && PROCESS_START_MODULES.has(name)) {
        context.report({ node: reportNode, messageId: 'directProcessStart', data: { what: `"${name}"` } });
      }
    }

    return {
      ImportDeclaration(node) {
        // A type-only import, whole or per specifier, starts nothing.
        if (node.importKind === 'type') return;
        if (node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.importKind === 'type')) return;
        checkModule(node, node.source);
      },

      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return;
        checkModule(node, node.source);
      },

      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return;
        checkModule(node, node.source);
      },

      ImportExpression(node) {
        checkModule(node, node.source);
      },

      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && isCreateRequireCall(node.init)) {
          requireFunctions.add(node.id.name);
        }
      },

      CallExpression(node) {
        const callee = node.callee;
        const [firstArgument] = node.arguments;
        const isRequire =
          (callee.type === 'Identifier' && (callee.name === 'require' || requireFunctions.has(callee.name))) ||
          isCreateRequireCall(callee) ||
          (callee.type === 'MemberExpression' && propertyName(callee.property, callee.computed) === 'getBuiltinModule');
        if (isRequire) checkModule(node, firstArgument);
      },

      MemberExpression(node) {
        const member = propertyName(node.property, node.computed);
        if (member !== null && BUN_PROCESS_MEMBERS.has(member) && isBunGlobal(node.object)) {
          context.report({ node, messageId: 'directProcessStart', data: { what: `Bun.${member}` } });
        }
      },
    };
  },
};

/**
 * @fileoverview Keep the process-wide bus out of code that must receive its bus: refuse `MakaioBus` and
 * `createBusInstance` (value import, type import, re-export, `typeof import(...)`, dynamic import) in every file
 * outside the allow-list of core, composition code, and named roots, and outside test files.
 */

/** Names that give access to the process-wide bus or mint a bus instance. */
const PROCESS_BUS_NAMES = new Set(['MakaioBus', 'createBusInstance']);

/**
 * Framework path prefixes (relative to the repository root, forward slashes) where the names are allowed: core,
 * kernel, composition code, and the named roots (runtimes, apps, bus server, browser process, scripts, SDK
 * clients). A prefix without a trailing slash matches every directory that starts with it (`bus-server*`).
 * A host repository adds its own composition roots through the `allowedPrefixes` option.
 */
const POSITIV = [
  'framework/core/bus-core/',
  'framework/packages/kernel/',
  'framework/packages/test-utils/',
  'framework/runtimes/',
  'framework/apps/',
  'framework/packages/bus-server',
  'framework/ui/',
  'framework/scripts/',
  'framework/sdks/',
];

/**
 * Test files are named roots and are exempt. Same pattern as `is_test` in the planning script, with the
 * `__tests__/`, `testing/`, `e2e/`, `__mocks__/` directories and the `*.test`, `*.fixture`, `*.mock(s)`,
 * `*.stories` file names.
 */
const TEST_FILE_PATTERN =
  /(\.test\.tsx?$|\/__tests__\/|\/tests\/|\.stories\.|\.mocks?\.tsx?$|\/e2e\/|\.fixture\.tsx?$|\/testing\/|\/__mocks__\/)/;

/**
 * Whether a file may use the process-bus names: it is a test file or lies under a `POSITIV` or configured prefix.
 * A prefix matches at the start of a relative path or after any `/` of an absolute path, so worktree locations
 * work too.
 * @param {string} filename - File name as ESLint reports it (absolute or relative).
 * @param {readonly string[]} allowedPrefixes - Additional allowed prefixes from the rule options.
 * @returns {boolean} True when the file is exempt.
 * @example isExempt('/repo/framework/runtimes/node/src/boot.ts', [])
 */
function isExempt(filename, allowedPrefixes) {
  const path = filename.replaceAll('\\', '/');
  if (TEST_FILE_PATTERN.test(path)) return true;
  return [...POSITIV, ...allowedPrefixes].some((prefix) => path.startsWith(prefix) || path.includes(`/${prefix}`));
}

/**
 * Read the name an import or export specifier refers to in the other module.
 * @param {import('estree').Node} node - Identifier or string literal.
 * @returns {string | null} The name, or null when it is not static.
 * @example specifierName(specifier.imported)
 */
function specifierName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * Read the leftmost identifier of an import-type qualifier (`MakaioBus` in `import('x').MakaioBus.foo`).
 * @param {import('estree').Node | null | undefined} qualifier - `qualifier` of a `TSImportType`.
 * @returns {string | null} The leftmost name, or null when absent.
 * @example leftmostName(node.qualifier)
 */
function leftmostName(qualifier) {
  let current = qualifier;
  while (current && current.type === 'TSQualifiedName') current = current.left;
  return current && current.type === 'Identifier' ? current.name : null;
}

/**
 * Read the name a member property is written with.
 * @param {import('estree').MemberExpression} node - Member access.
 * @returns {string | null} The name, or null when it is not static.
 * @example memberName(node)
 */
function memberName(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return null;
}

/**
 * Unwrap `await x` so `(await import('m')).MakaioBus` is seen as a member of the import.
 * @param {import('estree').Node} node - Object of a member access.
 * @returns {import('estree').Node} The awaited operand, or the node itself.
 * @example unwrapAwait(node.object)
 */
function unwrapAwait(node) {
  return node.type === 'AwaitExpression' ? node.argument : node;
}

/**
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Refuse MakaioBus and createBusInstance (value, type, re-export, typeof import, dynamic import) outside the process-bus allow-list and test files',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      processBusImport:
        '{{name}} is the process-wide bus; receive a bus through the extension context or a parameter instead. Only core, composition code, and named roots may use it.',
    },
    schema: [
      {
        type: 'object',
        properties: { allowedPrefixes: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    const allowedPrefixes = context.options[0]?.allowedPrefixes ?? [];
    if (isExempt(context.filename ?? context.getFilename(), allowedPrefixes)) return {};

    /**
     * Report a use of a process-bus name.
     * @param {import('estree').Node} node - Node to report on.
     * @param {string | null} name - The referenced name; ignored unless it is a process-bus name.
     * @example check(specifier, specifierName(specifier.imported))
     */
    function check(node, name) {
      if (name !== null && PROCESS_BUS_NAMES.has(name)) {
        context.report({ node, messageId: 'processBusImport', data: { name } });
      }
    }

    return {
      ImportSpecifier(node) {
        check(node, specifierName(node.imported));
      },

      ExportSpecifier(node) {
        // Only re-exports from another module reach the name; a local export names a local binding.
        if (node.parent.type === 'ExportNamedDeclaration' && node.parent.source) {
          check(node, specifierName(node.local));
        }
      },

      TSImportType(node) {
        check(node, leftmostName(node.qualifier));
      },

      MemberExpression(node) {
        if (unwrapAwait(node.object).type === 'ImportExpression') check(node, memberName(node));
      },

      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || !node.init) return;
        if (unwrapAwait(node.init).type !== 'ImportExpression') return;
        for (const property of node.id.properties) {
          if (property.type === 'Property' && !property.computed) check(property, specifierName(property.key));
        }
      },
    };
  },
};

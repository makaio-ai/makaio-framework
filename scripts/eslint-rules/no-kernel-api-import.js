/**
 * @fileoverview Keep the kernel names of `@makaio/bus-core` out of extension and product code: they mint, carry and
 * check call contexts, so only the kernel, transports, runtime boot code and test utilities may use them. Raw
 * `BusTransport.send` is reserved for transports and `bus-core`.
 */

/**
 * The one fixed list of kernel names. Keep it equal to the exports of
 * `framework/core/bus-core/src/kernel-api.ts` (a test compares the two).
 * `createBusInstance({ context })` is a kernel capability too, handled separately below.
 */
const KERNEL_NAMES = new Set([
  'mintCallContext',
  'createCarrierBus',
  'busContextOf',
  'busCarrierOf',
  'createBusContext',
  'createFilteredBus',
  'callFromReceive',
  'hostPartyOf',
  'assertCallCarrier',
  'ownCarrierOf',
]);

/** Package that exports the kernel names, and its kernel entry. */
const BUS_CORE_PACKAGE = '@makaio/bus-core';
const KERNEL_ENTRY = '@makaio/bus-core/kernel-api';

/**
 * Path segments (matched on the normalised absolute file name) in which kernel names are allowed. The composition
 * roots of an application are not listed here: the root configuration switches the rule off for them.
 */
const KERNEL_POSITIVE_LIST = [
  '/framework/core/bus-core/',
  '/framework/packages/kernel/',
  '/framework/packages/test-utils/',
  '/framework/transports/',
  '/framework/runtimes/',
];

/** Path segments in which raw `BusTransport.send` is allowed. */
const TRANSPORT_SEND_POSITIVE_LIST = ['/framework/core/bus-core/', '/framework/transports/'];

/**
 * Whether a file lies under one of the given path segments.
 * @param {string} filename - Absolute file name as ESLint reports it.
 * @param {readonly string[]} segments - Path segments with leading and trailing slash.
 * @returns {boolean} True when the file is inside one of them.
 * @example isInside(context.filename, KERNEL_POSITIVE_LIST)
 */
function isInside(filename, segments) {
  const normalized = filename.replaceAll('\\', '/');
  return segments.some((segment) => normalized.includes(segment));
}

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
 * Read the name a member property or key is written with.
 * @param {import('estree').Node} node - Property or key node.
 * @param {boolean} computed - Whether it was written in brackets.
 * @returns {string | null} The name, or null when it is not static.
 * @example propertyName(node.property, node.computed)
 */
function propertyName(node, computed) {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * Read the name an exported or imported binding is written with.
 * @param {import('estree').Node} node - Identifier or string literal of a specifier.
 * @returns {string | null} The name.
 * @example specifierName(specifier.imported)
 */
function specifierName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * Read the last name of an object expression: `transport` of `transport`, `this.transport`, `ctx.transport`.
 * @param {import('estree').Node} node - Object of a member access.
 * @returns {string | null} The last name, or null when there is none.
 * @example lastName(callee.object)
 */
function lastName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return propertyName(node.property, node.computed);
  return null;
}

/**
 * Whether a call is `createBusInstance(...)`, bare or as a member.
 * @param {import('estree').Node} callee - Callee of a call expression.
 * @returns {boolean} True for a `createBusInstance` call.
 * @example isCreateBusInstance(node.callee)
 */
function isCreateBusInstance(callee) {
  if (callee.type === 'Identifier') return callee.name === 'createBusInstance';
  return callee.type === 'MemberExpression' && propertyName(callee.property, callee.computed) === 'createBusInstance';
}

/**
 * Whether an object expression sets the `context` option.
 * @param {import('estree').Node | undefined} node - Candidate options argument.
 * @returns {boolean} True when a property named `context` is written (also shorthand).
 * @example hasContextOption(node.arguments[0])
 */
function hasContextOption(node) {
  if (!node || node.type !== 'ObjectExpression') return false;
  return node.properties.some(
    (property) => property.type === 'Property' && propertyName(property.key, property.computed) === 'context',
  );
}

/**
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Refuse the kernel names of @makaio/bus-core, the context option of createBusInstance and raw BusTransport.send outside the kernel, transports, runtimes and test utilities',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      kernelName:
        'Kernel name {{name}} of @makaio/bus-core is reserved for the kernel, transports, runtimes and test utilities; send with the call context you were given instead.',
      kernelEntry: '@makaio/bus-core/kernel-api is reserved for the kernel, transports, runtimes and test utilities.',
      contextOption:
        'The context option of createBusInstance is a kernel capability; it is reserved for the kernel, transports, runtimes and test utilities.',
      transportSend: 'BusTransport.send is reserved for transports and bus-core; send through the bus instead.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const kernelAllowed = isInside(filename, KERNEL_POSITIVE_LIST);
    const transportSendAllowed = isInside(filename, TRANSPORT_SEND_POSITIVE_LIST);

    /**
     * Report a module specifier that names the kernel entry.
     * @param {import('estree').Node} reportNode - Node to report on.
     * @param {import('estree').Node | null | undefined} sourceNode - The module specifier.
     * @returns {boolean} True when the specifier is the kernel entry (reported).
     * @example checkEntry(node, node.source)
     */
    function checkEntry(reportNode, sourceNode) {
      if (staticString(sourceNode) !== KERNEL_ENTRY) return false;
      context.report({ node: reportNode, messageId: 'kernelEntry' });
      return true;
    }

    /**
     * Report each kernel name in the specifiers of an import or re-export from `@makaio/bus-core`.
     * @param {import('estree').Node} node - Import or export declaration.
     * @example checkSpecifiers(node)
     */
    function checkSpecifiers(node) {
      const source = staticString(node.source);
      if (source === KERNEL_ENTRY) {
        context.report({ node, messageId: 'kernelEntry' });
        return;
      }
      if (source !== BUS_CORE_PACKAGE) return;
      for (const specifier of node.specifiers ?? []) {
        // `import { x as y }` names `x` in `imported`; `export { x as y } from` names `x` in `local`.
        let name = null;
        if (specifier.type === 'ImportSpecifier') name = specifierName(specifier.imported);
        else if (specifier.type === 'ExportSpecifier') name = specifierName(specifier.local);
        if (name !== null && KERNEL_NAMES.has(name)) {
          context.report({ node: specifier, messageId: 'kernelName', data: { name } });
        }
      }
    }

    const visitors = {};

    if (!kernelAllowed) {
      Object.assign(visitors, {
        ImportDeclaration: checkSpecifiers,
        ExportNamedDeclaration(node) {
          if (node.source) checkSpecifiers(node);
        },
        ExportAllDeclaration(node) {
          checkEntry(node, node.source);
        },
        ImportExpression(node) {
          checkEntry(node, node.source);
        },
        TSImportType(node) {
          const argument = node.argument?.literal ?? node.argument;
          checkEntry(node, argument);
        },
      });
    }

    return {
      ...visitors,

      CallExpression(node) {
        const callee = node.callee;
        const [firstArgument] = node.arguments;

        if (!kernelAllowed) {
          if (callee.type === 'Identifier' && callee.name === 'require') checkEntry(node, firstArgument);
          if (isCreateBusInstance(callee) && hasContextOption(firstArgument)) {
            context.report({ node, messageId: 'contextOption' });
          }
        }

        if (
          !transportSendAllowed &&
          callee.type === 'MemberExpression' &&
          propertyName(callee.property, callee.computed) === 'send'
        ) {
          const owner = lastName(callee.object);
          if (owner !== null && /transport/i.test(owner)) {
            context.report({ node: callee, messageId: 'transportSend' });
          }
        }
      },

      TSIndexedAccessType(node) {
        if (transportSendAllowed) return;
        const { objectType, indexType } = node;
        if (
          objectType.type === 'TSTypeReference' &&
          objectType.typeName.type === 'Identifier' &&
          objectType.typeName.name === 'BusTransport' &&
          indexType.type === 'TSLiteralType' &&
          staticString(indexType.literal) === 'send'
        ) {
          context.report({ node, messageId: 'transportSend' });
        }
      },
    };
  },
};

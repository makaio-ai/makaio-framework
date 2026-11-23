/**
 * @fileoverview Refuse `.own(...)` lexically inside a handler body, except for a literally readable concurrent
 * purpose (`shared-work`, `schedule`, `observer`, `stop`). A handler sends with the call context of the message it
 * handles (`ctx.call`).
 *
 * Decision: `.own('<purpose>')` is allowed inside a handler when the first argument is a string literal (or a
 * template literal without expressions) naming a concurrent purpose (`CONCURRENT_OWN_WORK_PURPOSES`: `shared-work`,
 * `schedule`, `observer`, `stop`). Those purposes are declared to run alongside the handler's call. Everything else
 * is still reported: `root`, `start`, any other literal, a missing argument, and every argument that is not
 * literally readable (identifier, call, template literal with expressions).
 */

import { createHandlerScope, propertyName } from './handler-scope.js';

/**
 * The purposes `.own(...)` may name inside a handler. Must equal `CONCURRENT_OWN_WORK_PURPOSES` of the bus core;
 * a test pins the two lists together.
 * @type {readonly string[]}
 */
export const CONCURRENT_OWN_PURPOSES = ['schedule', 'observer', 'shared-work', 'stop'];

/**
 * Read the literal text of an argument, when it is literally readable.
 * @param {import('estree').Node | undefined} argument - The first argument of the `.own(...)` call.
 * @returns {string | undefined} The string value, or `undefined` for anything that is not a plain string literal
 *   or a template literal without expressions.
 */
function literalText(argument) {
  if (!argument) return undefined;
  if (argument.type === 'Literal' && typeof argument.value === 'string') return argument.value;
  if (argument.type === 'TemplateLiteral' && argument.expressions.length === 0 && argument.quasis.length === 1) {
    return argument.quasis[0].value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Refuse `.own(...)` inside a handler body unless it names a literally readable concurrent purpose (shared-work, schedule, observer, stop)',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      ownInHandler:
        '.own(...) is refused in a handler body unless it names a literally readable concurrent purpose (shared-work, schedule, observer, stop); send with the call of the handled message (ctx.call).',
    },
    schema: [],
  },

  create(context) {
    const scope = createHandlerScope();

    return {
      FunctionDeclaration: scope.enterFunction,
      'FunctionDeclaration:exit': scope.exitFunction,
      FunctionExpression: scope.enterFunction,
      'FunctionExpression:exit': scope.exitFunction,
      ArrowFunctionExpression: scope.enterFunction,
      'ArrowFunctionExpression:exit': scope.exitFunction,

      CallExpression(node) {
        if (!scope.isInHandler()) return;
        const callee = node.callee;
        if (callee.type === 'MemberExpression' && propertyName(callee.property, callee.computed) === 'own') {
          const purpose = literalText(node.arguments[0]);
          if (purpose !== undefined && CONCURRENT_OWN_PURPOSES.includes(purpose)) return;
          context.report({ node, messageId: 'ownInHandler' });
        }
      },
    };
  },
};

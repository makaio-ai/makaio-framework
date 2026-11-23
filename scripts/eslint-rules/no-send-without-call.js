/**
 * @fileoverview Code that has a call context in reach forwards it: refuse a bus or channel send without call
 * (`bus.request(subject, payload)`) inside a handler body and inside a function that carries a call context.
 *
 * The rule is lexical, without type information (typed lint is not available in this repository), so it works by name
 * pattern. What it recognises:
 *
 * - Send: a call `<receiver>.request|requestOptional|emit|broadcast(...)` whose receiver is `bus`, `*Bus`, `*.bus`,
 *   `channel`, `*Channel` or `*.channel` (also through `!` and `?.`).
 * - Scope: the body of a function registered as a handler (`on`, `once`, `intercept`, `registerHandler`,
 *   `useBusEvent`) or typed with a handler context on its first parameter (`handler-scope.js`), and the body of a
 *   function with a parameter named `call` or typed `CallContext` (also as a default value or parameter property).
 *   Nested functions stay inside the scope of the outer one.
 * - Accepted first argument: an identifier or member ending in `call`/`Call` (`call`, `ctx.call`, `forwardedCall`,
 *   `this.call`), a `<x>.own(...)` call, or an identifier whose declaration or parameter in scope is annotated
 *   `CallContext`; all of them also through `as`, `satisfies`, `!` and `<T>` wrappers. There is no heuristic on helper
 *   calls such as `buildCall(...)`.
 *
 * Limits, all by design of a name-based rule:
 *
 * - Helpers whose context has no `call` in the name and no `CallContext` annotation are not seen as call context
 *   carriers: a send inside such a function is missed, and a context they return is not accepted as first argument.
 * - Classes sending through `this.bus` are only checked inside handler bodies and functions with a call parameter, not
 *   by their class; methods of a class are scopes only through their own parameters.
 * - Callbacks outside the handler body (a function declared elsewhere and passed in later) are not in scope; callbacks
 *   inside it are.
 * - A spread first argument (`bus.request(...args)`) cannot be judged and is not reported.
 * - Bracket access with a non-literal key (`bus[name](...)`), destructured methods (`const { request } = bus`) and
 *   aliases of the bus under another name are not recognised as sends.
 * - Destructured parameters (`({ call }) => ...`) do not make a call scope.
 * - A receiver that matches the name pattern but is a foreign API (a node `EventEmitter` called `eventBus`) is
 *   reported; rename it or disable the rule on that line.
 */

import { calleeName, createHandlerScope, propertyName } from './handler-scope.js';

/** Send operations of buses and channels. */
const SEND_OPERATIONS = new Set(['request', 'requestOptional', 'emit', 'broadcast']);

/** Name of the call context type. */
const CALL_CONTEXT_TYPE = 'CallContext';

/**
 * Whether a name is the bus or channel receiver of a send: `bus`, `channel` or a name ending in `Bus`/`Channel`.
 * @param {string} name - Identifier or property name.
 * @returns {boolean} True for receiver names.
 * @example isReceiverName('sessionBus')
 */
function isReceiverName(name) {
  return name === 'bus' || name === 'channel' || name.endsWith('Bus') || name.endsWith('Channel');
}

/**
 * Whether a name reads as a call context: `call` or a name ending in `Call`.
 * @param {string | null} name - Identifier or property name.
 * @returns {boolean} True for `call`, `forwardedCall`; false for `recall`.
 * @example isCallName('forwardedCall')
 */
function isCallName(name) {
  return name === 'call' || (name !== null && name.endsWith('Call'));
}

/**
 * Strip wrappers that do not change the value: `as`, `satisfies`, `!`, `<T>x` and optional chains.
 * @param {import('estree').Node} node - Expression.
 * @returns {import('estree').Node} The wrapped expression.
 * @example unwrap(node.arguments[0])
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
 * Whether a type annotation wrapper names `CallContext` (plain or qualified).
 * @param {import('estree').Node | null | undefined} annotation - A `TSTypeAnnotation` wrapper or null.
 * @returns {boolean} True when the annotated type is `CallContext`.
 * @example isCallContextAnnotation(identifier.typeAnnotation)
 */
function isCallContextAnnotation(annotation) {
  const type = annotation?.typeAnnotation;
  if (!type || type.type !== 'TSTypeReference') return false;
  const name = type.typeName;
  if (name.type === 'Identifier') return name.name === CALL_CONTEXT_TYPE;
  return name.type === 'TSQualifiedName' && name.right.name === CALL_CONTEXT_TYPE;
}

/**
 * Read the binding identifier of a parameter, through a default value or a parameter property.
 * @param {import('estree').Node} param - Parameter node.
 * @returns {import('estree').Identifier | null} The identifier, or null for patterns.
 * @example parameterIdentifier(node.params[0])
 */
function parameterIdentifier(param) {
  if (param.type === 'TSParameterProperty') return parameterIdentifier(param.parameter);
  if (param.type === 'AssignmentPattern') return parameterIdentifier(param.left);
  return param.type === 'Identifier' ? param : null;
}

/**
 * Whether a function has a parameter named `call` or typed `CallContext`.
 * @param {import('estree').Node} fn - Function node.
 * @returns {boolean} True when it carries a call context parameter.
 * @example hasCallParameter(node)
 */
function hasCallParameter(fn) {
  return fn.params.some((param) => {
    const identifier = parameterIdentifier(param);
    return identifier !== null && (identifier.name === 'call' || isCallContextAnnotation(identifier.typeAnnotation));
  });
}

/**
 * Read the receiver name of a member access: `bus` for `bus.x` and `this.bus.x` alike.
 * @param {import('estree').Node} receiver - Object of the callee member expression.
 * @returns {string | null} The identifier or property name the receiver is written with, or null.
 * @example receiverName(callee.object)
 */
function receiverName(receiver) {
  const node = unwrap(receiver);
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return propertyName(node.property, node.computed);
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
        'Refuse a bus or channel send without call context where a call context is in reach (handler bodies and functions with a call parameter)',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      sendWithoutCall:
        "'{{operation}}' sends without a call context although one is in reach. Pass the handled message's ctx.call (or the call parameter) as first argument.",
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.sourceCode;
    const handlerScope = createHandlerScope();
    /** Stack of flags, one per entered function, recording whether it has a call parameter. */
    const callScopes = [];
    /** Number of entered functions with a call parameter. */
    let callScopeDepth = 0;

    /**
     * Enter a function for both scope trackers.
     * @param {import('estree').Node} node - Function node.
     */
    function enterFunction(node) {
      handlerScope.enterFunction(node);
      const carriesCall = hasCallParameter(node);
      callScopes.push(carriesCall);
      if (carriesCall) callScopeDepth += 1;
    }

    /** Leave a function for both scope trackers. */
    function exitFunction() {
      handlerScope.exitFunction();
      if (callScopes.pop()) callScopeDepth -= 1;
    }

    /**
     * Whether a declaration of the identifier in scope is annotated `CallContext`.
     * @param {import('estree').Identifier} identifier - The identifier.
     * @returns {boolean} True when a variable or parameter of that name is annotated `CallContext`.
     * @example isAnnotatedCallContext(node)
     */
    function isAnnotatedCallContext(identifier) {
      for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
        const variable = scope.set.get(identifier.name);
        if (variable) {
          return variable.defs.some((definition) => isCallContextAnnotation(definition.name.typeAnnotation));
        }
      }
      return false;
    }

    /**
     * Whether an argument is recognised as a call context.
     * @param {import('estree').Node} argument - First argument of the send.
     * @returns {boolean} True for call-named identifiers and members, `.own(...)` calls and annotated identifiers.
     * @example isCallArgument(node.arguments[0])
     */
    function isCallArgument(argument) {
      const node = unwrap(argument);
      switch (node.type) {
        case 'Identifier':
          return isCallName(node.name) || isAnnotatedCallContext(node);
        case 'MemberExpression':
          return isCallName(propertyName(node.property, node.computed));
        case 'CallExpression': {
          const callee = unwrap(node.callee);
          return callee.type === 'MemberExpression' && propertyName(callee.property, callee.computed) === 'own';
        }
        default:
          return false;
      }
    }

    /**
     * Whether a call is a send on a bus or channel receiver.
     * @param {import('estree').CallExpression} node - Call expression.
     * @returns {boolean} True for `<receiver>.request|requestOptional|emit|broadcast(...)`.
     * @example isSend(node)
     */
    function isSend(node) {
      const callee = unwrap(node.callee);
      if (callee.type !== 'MemberExpression') return false;
      if (!SEND_OPERATIONS.has(calleeName(callee) ?? '')) return false;
      const receiver = receiverName(callee.object);
      return receiver !== null && isReceiverName(receiver);
    }

    return {
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,

      CallExpression(node) {
        if (!handlerScope.isInHandler() && callScopeDepth === 0) return;
        if (!isSend(node)) return;
        const [first] = node.arguments;
        if (first?.type === 'SpreadElement') return;
        if (first && isCallArgument(first)) return;
        context.report({ node, messageId: 'sendWithoutCall', data: { operation: calleeName(unwrap(node.callee)) } });
      },
    };
  },
};

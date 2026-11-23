/**
 * @fileoverview Shared recognition of handler bodies for ESLint rules that reason about code running inside a bus
 * handler: which calls register handlers, which context types mark a function as a handler, and a depth tracker
 * that follows nested functions.
 */

/** Methods and functions whose function arguments are handler bodies. */
export const HANDLER_REGISTRATIONS = new Set(['on', 'once', 'intercept', 'registerHandler', 'useBusEvent']);

/** Context types that mark a function as a handler when its first parameter is annotated with one. */
export const HANDLER_CONTEXT_TYPES = new Set([
  'EventContext',
  'RequestContext',
  'WildcardContext',
  'InterceptorContext',
  'BaseMessageContext',
]);

/**
 * Read the name a member property is written with.
 * @param {import('estree').Node} node - Property node of a member access.
 * @param {boolean} computed - Whether it was written in brackets.
 * @returns {string | null} The name, or null when it is not static.
 * @example propertyName(node.property, node.computed)
 */
export function propertyName(node, computed) {
  if (!computed && node.type === 'Identifier') return node.name;
  if (computed && node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * Read the name a call is made through: `registerHandler(...)` and `bus.on(...)` yield `registerHandler` and `on`.
 * @param {import('estree').Node} callee - Callee of a call expression.
 * @returns {string | null} The name, or null when it is not static.
 * @example calleeName(node.callee)
 */
export function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') return propertyName(callee.property, callee.computed);
  return null;
}

/**
 * Whether a node is a function expression (arrow or `function`).
 * @param {import('estree').Node} node - Candidate node.
 * @returns {boolean} True for arrow functions and function expressions.
 * @example isFunctionExpression(argument)
 */
export function isFunctionExpression(node) {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

/**
 * Whether the first parameter of a function is annotated with one of the handler context types.
 * @param {import('estree').Node} fn - Function node.
 * @returns {boolean} True when the annotation names a handler context type.
 * @example hasHandlerContextParameter(node)
 */
export function hasHandlerContextParameter(fn) {
  const [first] = fn.params;
  if (!first) return false;
  const annotation = first.typeAnnotation?.typeAnnotation;
  if (!annotation || annotation.type !== 'TSTypeReference') return false;
  const name = annotation.typeName;
  if (name.type === 'Identifier') return HANDLER_CONTEXT_TYPES.has(name.name);
  return name.type === 'TSQualifiedName' && HANDLER_CONTEXT_TYPES.has(name.right.name);
}

/**
 * Whether a function is passed directly as an argument to a handler registration.
 * @param {import('estree').Node} fn - Function node.
 * @returns {boolean} True when the parent is a registration call and the function is one of its arguments.
 * @example isRegisteredHandler(node)
 */
export function isRegisteredHandler(fn) {
  const parent = fn.parent;
  if (!parent || parent.type !== 'CallExpression' || !parent.arguments.includes(fn)) return false;
  const name = calleeName(parent.callee);
  return name !== null && HANDLER_REGISTRATIONS.has(name);
}

/**
 * Create a handler depth tracker; call it once per rule instance, because the counter is per instance. A nested
 * function stays inside the outer handler body.
 * @returns {{ enterFunction: (node: import('estree').Node) => void, exitFunction: () => void, isInHandler: () => boolean }}
 * Visitors for every function node kind and a query that is true while inside at least one handler.
 * @example const scope = createHandlerScope(); // then wire scope.enterFunction / scope.exitFunction as visitors
 */
export function createHandlerScope() {
  /** Handler functions currently entered. */
  let handlerDepth = 0;
  /** Stack of flags, one per entered function, recording whether it raised `handlerDepth`. */
  const entered = [];

  return {
    /**
     * Enter a function and count it when it is a handler.
     * @param {import('estree').Node} node - Function node.
     */
    enterFunction(node) {
      const isHandler = isFunctionExpression(node)
        ? isRegisteredHandler(node) || hasHandlerContextParameter(node)
        : hasHandlerContextParameter(node);
      entered.push(isHandler);
      if (isHandler) handlerDepth += 1;
    },

    /** Leave a function and undo what `enterFunction` counted. */
    exitFunction() {
      if (entered.pop()) handlerDepth -= 1;
    },

    /**
     * Whether the traversal is currently inside a handler body.
     * @returns {boolean} True when at least one entered function is a handler.
     */
    isInHandler() {
      return handlerDepth > 0;
    },
  };
}

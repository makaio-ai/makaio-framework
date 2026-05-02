/**
 * @fileoverview Enforce using filter option on bus.on() instead of inline if-conditionals
 */

/**
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce using the `filter` option on bus.on() subscriptions instead of inline if-conditionals that check payload properties',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      preferFilter:
        'Use the `filter` option on bus.on() instead of inline if-conditional. ' +
        'Replace guard checking `{{property}}` with: bus.on(subject, handler, { filter: { {{filterKey}}: value } })',
    },
    schema: [],
  },

  create(context) {
    /**
     * Check if a node is accessing payload properties (payload.x or ctx.payload.x).
     * @param {import('estree').Node} node - Node to check
     * @returns {{ isPayloadAccess: boolean, propertyName: string | null }} Result with access flag and property name
     * @example isPayloadPropertyAccess(node)
     */
    function isPayloadPropertyAccess(node) {
      if (node.type !== 'MemberExpression') {
        return { isPayloadAccess: false, propertyName: null };
      }

      const propertyName = node.property.type === 'Identifier' ? node.property.name : null;

      // Check for direct payload.x
      if (node.object.type === 'Identifier' && node.object.name === 'payload') {
        return { isPayloadAccess: true, propertyName };
      }

      // Check for ctx.payload.x
      if (
        node.object.type === 'MemberExpression' &&
        node.object.property.type === 'Identifier' &&
        node.object.property.name === 'payload'
      ) {
        return { isPayloadAccess: true, propertyName };
      }

      return { isPayloadAccess: false, propertyName: null };
    }

    /**
     * Check if a binary expression is a payload comparison that could be a filter.
     * @param {import('estree').BinaryExpression} node - Binary expression to check
     * @returns {{ isFilterable: boolean, propertyName: string | null }} Result with filter flag and property name
     * @example isFilterableComparison(node)
     */
    function isFilterableComparison(node) {
      if (node.operator !== '===' && node.operator !== '!==') {
        return { isFilterable: false, propertyName: null };
      }

      // Check left side for payload access
      const leftCheck = isPayloadPropertyAccess(node.left);
      if (leftCheck.isPayloadAccess) {
        return { isFilterable: true, propertyName: leftCheck.propertyName };
      }

      // Check right side for payload access
      const rightCheck = isPayloadPropertyAccess(node.right);
      if (rightCheck.isPayloadAccess) {
        return { isFilterable: true, propertyName: rightCheck.propertyName };
      }

      return { isFilterable: false, propertyName: null };
    }

    /**
     * Check if a call expression passes payload.* as argument.
     * @param {import('estree').CallExpression} node - Call expression to check
     * @returns {{ isFilterable: boolean, propertyName: string | null }} Result with filter flag and property name
     * @example isMethodCallWithPayloadArg(node)
     */
    function isMethodCallWithPayloadArg(node) {
      for (const arg of node.arguments) {
        const check = isPayloadPropertyAccess(arg);
        if (check.isPayloadAccess) {
          return { isFilterable: true, propertyName: check.propertyName };
        }
      }
      return { isFilterable: false, propertyName: null };
    }

    /**
     * Check if an if statement is a guard pattern (if (condition) return).
     * @param {import('estree').IfStatement} node - If statement to check
     * @returns {boolean} True if this is a guard pattern with early return
     * @example isGuardPattern(node)
     */
    function isGuardPattern(node) {
      const consequent = node.consequent;

      // Direct return statement
      if (consequent.type === 'ReturnStatement') {
        return true;
      }

      // Block with single return statement
      if (
        consequent.type === 'BlockStatement' &&
        consequent.body.length === 1 &&
        consequent.body[0].type === 'ReturnStatement'
      ) {
        return true;
      }

      return false;
    }

    /**
     * Extract filterable property from an if statement test.
     * @param {import('estree').Node} test - The test expression of an if statement
     * @returns {{ isFilterable: boolean, propertyName: string | null }} Result with filter flag and property name
     * @example extractFilterableProperty(test)
     */
    function extractFilterableProperty(test) {
      // Direct comparison: if (payload.sessionId !== sessionId)
      if (test.type === 'BinaryExpression') {
        return isFilterableComparison(test);
      }

      // Negation: if (!payload.sessionId) or if (!this.matchesSession(payload.sessionId))
      if (test.type === 'UnaryExpression' && test.operator === '!') {
        if (test.argument.type === 'CallExpression') {
          return isMethodCallWithPayloadArg(test.argument);
        }
        const innerCheck = isPayloadPropertyAccess(test.argument);
        if (innerCheck.isPayloadAccess) {
          return { isFilterable: true, propertyName: innerCheck.propertyName };
        }
      }

      // Method call: if (this.matchesSession(payload.sessionId))
      if (test.type === 'CallExpression') {
        return isMethodCallWithPayloadArg(test);
      }

      return { isFilterable: false, propertyName: null };
    }

    /**
     * Check a function body for patterns that should use filter.
     * @param {import('estree').Node} handlerNode - The handler function node
     * @param {import('estree').CallExpression} callNode - The .on() call expression
     * @example checkHandlerBody(handlerNode, callNode)
     */
    function checkHandlerBody(handlerNode, callNode) {
      let body;

      if (handlerNode.type === 'ArrowFunctionExpression') {
        if (handlerNode.body.type === 'BlockStatement') {
          body = handlerNode.body.body;
        } else {
          // Expression body, skip
          return;
        }
      } else if (handlerNode.type === 'FunctionExpression') {
        body = handlerNode.body.body;
      } else {
        return;
      }

      if (!body || body.length === 0) return;

      // Check first statement for guard pattern (early return)
      const firstStatement = body[0];
      if (firstStatement.type !== 'IfStatement') return;

      // Flag two patterns:
      // 1. Guard pattern: if (condition) return; (skips rest of handler)
      // 2. Exclusive wrapper: if (condition) { ...work... } as ONLY statement, no else
      //    This indicates "only do work if matches" which is filtering
      const isGuard = isGuardPattern(firstStatement);
      const isExclusiveWrapper =
        body.length === 1 && // Only statement in handler
        !firstStatement.alternate && // No else branch
        firstStatement.consequent.type === 'BlockStatement'; // Has a block body

      if (!isGuard && !isExclusiveWrapper) return;

      const { isFilterable, propertyName } = extractFilterableProperty(firstStatement.test);

      if (isFilterable && propertyName) {
        // Check if there's already a filter option
        const args = callNode.arguments;
        if (args.length >= 3) {
          const optionsArg = args[2];
          if (optionsArg.type === 'ObjectExpression') {
            const hasFilter = optionsArg.properties.some(
              (prop) => prop.type === 'Property' && prop.key.type === 'Identifier' && prop.key.name === 'filter',
            );
            if (hasFilter) {
              // Already has filter, don't report
              return;
            }
          }
        }

        context.report({
          node: firstStatement,
          messageId: 'preferFilter',
          data: {
            property: `payload.${propertyName}`,
            filterKey: propertyName,
          },
        });
      }
    }

    return {
      CallExpression(node) {
        // Check if this is a .on() call
        if (node.callee.type !== 'MemberExpression') return;
        if (node.callee.property.type !== 'Identifier') return;
        if (node.callee.property.name !== 'on') return;

        // Need at least 2 arguments: subject and handler
        if (node.arguments.length < 2) return;

        const handlerArg = node.arguments[1];

        // Handler should be a function
        if (handlerArg.type !== 'ArrowFunctionExpression' && handlerArg.type !== 'FunctionExpression') {
          return;
        }

        checkHandlerBody(handlerArg, node);
      },
    };
  },
};

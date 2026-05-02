/**
 * @fileoverview Enforce using dot notation for bus subjects instead of bracket notation with string literals
 */

/**
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce using dot notation (Subjects.agent.started) instead of bracket notation (Subjects["agent.started"]) for bus subjects',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      useDotNotation:
        'Use dot notation `{{suggested}}` instead of bracket notation. ' +
        'Subjects are nested objects, not string-keyed maps.',
    },
    schema: [],
  },

  create(context) {
    return {
      MemberExpression(node) {
        // Only check bracket notation with string literals
        if (!node.computed) return;
        if (node.property.type !== 'Literal') return;
        if (typeof node.property.value !== 'string') return;

        const keyValue = node.property.value;

        // Only flag if the string contains dots (e.g., 'adapter.config.list')
        // This indicates someone is using a flat string key instead of nested property access
        if (!keyValue.includes('.')) return;

        // Check if the object name ends with 'Subjects' (common naming convention)
        let objectName = '';
        if (node.object.type === 'Identifier') {
          objectName = node.object.name;
        } else if (node.object.type === 'MemberExpression' && node.object.property.type === 'Identifier') {
          objectName = node.object.property.name;
        }

        if (!objectName.endsWith('Subjects')) return;

        // Build the suggested dot notation
        const dotNotation = `${objectName}.${keyValue.replace(/\./g, '.')}`;

        context.report({
          node,
          messageId: 'useDotNotation',
          data: {
            suggested: dotNotation,
          },
        });
      },
    };
  },
};

/**
 * Helper for creating static client definitions.
 *
 * This validates and normalizes static client definition literals at module
 * initialization time so client packages get one canonical shape with schema
 * defaults applied.
 * @packageDocumentation
 */

import { ClientDefinitionSchema, type ClientDefinition, type ClientDefinitionInput } from './definition.js';

/**
 * Recursively freeze a parsed client definition so nested arrays and objects
 * remain immutable after module initialization.
 * @param value - Parsed client definition fragment to freeze
 * @returns Deep-frozen value
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }

    return Object.freeze(value);
  }

  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue);
    }

    return Object.freeze(value);
  }

  return value;
}

/**
 * Create an immutable client definition from a static object literal.
 * @param definition - Client definition to return
 * @returns Validated, normalized, frozen client definition
 */
export function createClientDefinition(definition: ClientDefinitionInput): ClientDefinition {
  return deepFreeze(ClientDefinitionSchema.parse(definition));
}

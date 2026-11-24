import type { RulesCapability } from './capability.js';

/**
 * Creates the rules capability for a context with no active rule host.
 * @returns A capability that refuses validation and reads an empty source.
 */
export function createUnavailableRulesCapability(): RulesCapability {
  return {
    validate: async () => {
      throw new Error('Rule-set validation is unavailable in this context');
    },
    triggers: () => ({ current: () => [], onChange: () => () => {} }),
  };
}

import type { ContributionProcessor } from '@makaio/kernel';
import { RuleContributionsToken } from './packages.js';
import type { RuleContributionsService } from './rule-contributions-service.js';

/**
 * Processes trigger, lookup, group-strategy, and rule-block
 * contributions from extensions.
 *
 * During activation: registers each contributed kind with its registry on
 * the rule contributions service. Namespace and owner checks are NOT
 * repeated here — each registry already enforces them once, through the
 * shared generic registry core; a rejected registration here is the registry's rejection
 * surfacing through this processor. Registration across the four kinds is
 * atomic per extension: a later kind's rejection rolls back every kind this
 * activation already registered. On stop: deregisters all contributions from
 * that extension.
 * @param getService - Host lookup for the live, writable contributions service.
 * @returns Contribution processor for rule contribution registration.
 */
export function createRuleContributionProcessor(
  getService: () => RuleContributionsService | undefined,
): ContributionProcessor {
  const cleanups = new Map<string, () => void>();

  return {
    filter: (pkg) => !!(pkg.triggers?.length || pkg.lookups?.length || pkg.groupStrategies?.length || pkg.ruleBlock),

    async processActivated(name, pkg) {
      const service = getService();
      if (!service) {
        throw new Error(
          `RuleContributionProcessor: RuleContributionsService is not available — ensure ` +
            `'${RuleContributionsToken.name}' is started before extensions with rule contributions.`,
        );
      }

      const triggers = pkg.triggers ?? [];
      const lookups = pkg.lookups ?? [];
      const groupStrategies = pkg.groupStrategies ?? [];
      const ruleBlock = pkg.ruleBlock;

      const registered = {
        triggers: false,
        lookups: false,
        groupStrategies: false,
        ruleBlock: false,
      };
      try {
        if (triggers.length) {
          service.triggers.register(name, triggers);
          registered.triggers = true;
        }
        if (lookups.length) {
          service.lookups.register(name, lookups);
          registered.lookups = true;
        }
        if (groupStrategies.length) {
          service.groupStrategies.register(name, groupStrategies);
          registered.groupStrategies = true;
        }
        if (ruleBlock) {
          service.ruleBlocks.register(name, ruleBlock);
          registered.ruleBlock = true;
        }
      } catch (error) {
        if (registered.triggers) service.triggers.deregister(name);
        if (registered.lookups) service.lookups.deregister(name);
        if (registered.groupStrategies) service.groupStrategies.deregister(name);
        if (registered.ruleBlock) service.ruleBlocks.deregister(name);
        throw error;
      }

      cleanups.set(name, () => {
        service.triggers.deregister(name);
        service.lookups.deregister(name);
        service.groupStrategies.deregister(name);
        service.ruleBlocks.deregister(name);
      });
    },

    async processStopped(name) {
      const cleanup = cleanups.get(name);
      if (!cleanup) return;
      try {
        cleanup();
      } catch (error) {
        console.error(`[RuleContributionProcessor] Deregister error for "${name}":`, error);
      }
      cleanups.delete(name);
    },
  };
}

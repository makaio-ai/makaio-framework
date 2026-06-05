import type { ContributionProcessor } from '@makaio/kernel';
import { TransitionPipelineToken } from '../framework-packages.js';

/**
 * Processes transition rule and action contributions from extensions.
 *
 * During activation: validates namespace prefixes, then registers rules and
 * actions with the {@link TransitionPipelineService}. On stop: deregisters
 * all contributions from that extension.
 * @returns Contribution processor for transition pipeline registration.
 */
export function createTransitionContributionProcessor(): ContributionProcessor {
  const cleanups = new Map<string, () => void>();

  return {
    filter: (pkg) => !!(pkg.transitionRules?.rules?.length || pkg.transitionActions?.actions),

    async processActivated(name, pkg, ctx) {
      const service = ctx.getService(TransitionPipelineToken);
      if (!service) {
        throw new Error(
          `TransitionContributionProcessor: TransitionPipelineService is not available — ensure ` +
            `'${TransitionPipelineToken.name}' is started before extensions with transitionRules or transitionActions.`,
        );
      }

      const rules = pkg.transitionRules?.rules ?? [];
      const actions = pkg.transitionActions?.actions;
      const hasRules = rules.length > 0;
      const hasActions = actions !== undefined;

      if (hasRules) {
        assertRuleNamespace(name, rules);
      }
      if (hasActions) {
        assertActionNamespace(name, actions);
      }

      let rulesRegistered = false;
      let actionsRegistered = false;
      try {
        if (hasRules) {
          service.ruleRegistry.register(name, rules);
          rulesRegistered = true;
        }
        if (hasActions) {
          service.actionRegistry.register(name, actions);
          actionsRegistered = true;
        }
      } catch (error) {
        if (rulesRegistered) {
          service.ruleRegistry.deregister(name);
        }
        if (actionsRegistered) {
          service.actionRegistry.deregister(name);
        }
        throw error;
      }

      cleanups.set(name, () => {
        if (hasRules) {
          service.ruleRegistry.deregister(name);
        }
        if (hasActions) {
          service.actionRegistry.deregister(name);
        }
      });
    },

    async processStopped(name) {
      const cleanup = cleanups.get(name);
      if (!cleanup) return;
      try {
        cleanup();
      } catch (error) {
        console.error(`[TransitionContributionProcessor] Deregister error for "${name}":`, error);
      }
      cleanups.delete(name);
    },
  };
}

/**
 * Assert that all rule IDs are prefixed with the extension namespace.
 * @param extensionName - Extension name used as namespace prefix.
 * @param rules - Rules to validate.
 * @throws If any rule ID does not start with `'<extensionName>.'`.
 */
function assertRuleNamespace(extensionName: string, rules: readonly { id: string }[]): void {
  const prefix = `${extensionName}.`;
  for (const rule of rules) {
    if (!rule.id.startsWith(prefix)) {
      throw new Error(`TransitionContributionProcessor: rule '${rule.id}' must be namespaced by extension '${prefix}'`);
    }
  }
}

/**
 * Assert that all action type keys are prefixed with the extension namespace.
 * @param extensionName - Extension name used as namespace prefix.
 * @param actions - Action factories map to validate.
 * @throws If any action type key does not start with `'<extensionName>.'`.
 */
function assertActionNamespace(extensionName: string, actions: Readonly<Record<string, unknown>>): void {
  const prefix = `${extensionName}.`;
  for (const key of Object.keys(actions)) {
    if (!key.startsWith(prefix)) {
      throw new Error(
        `TransitionContributionProcessor: action type '${key}' must be namespaced by extension '${prefix}'`,
      );
    }
  }
}

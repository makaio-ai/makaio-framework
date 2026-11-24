import type { IMakaioBus } from '@makaio/bus-core';
import { createCarrierBus } from '@makaio/bus-core/kernel-api';
import { MAKAIO_RULES_PARTY_KIND } from '@makaio/core';
import { dep, type MakaioNodeExtension } from '@makaio/contracts';
import type { RightsCapability } from '@makaio/contracts/rights';
import type { RuleSendAuthorization } from './send-bus-request-reaction.js';
import { automationTriggerBuiltinsPackage } from '../../automation-trigger/builtins/package.js';
import { ReactionRegistryToken } from '../../reaction/packages.js';
import { RuleContributionsToken } from '../packages.js';
import { allGroupStrategy } from './all-group-strategy.js';
import { busMessageTrigger } from './bus-message-trigger.js';
import { createHasRightLookup } from './has-right-lookup.js';
import { createSendBusRequestReaction } from './send-bus-request-reaction.js';

/**
 * Adds the rule contributions to the existing core owner.
 * @param bus - Host bus used to bind the rule evaluation carrier.
 * @param rights - Host authorization for the built-in rule contributions.
 * @returns The core extension with its rule contributions.
 */
export function createRuleContributionsBuiltinsPackage(
  bus: IMakaioBus,
  rights: {
    resolveLookupRight: RightsCapability['resolve'];
    resolveRuleSendRight: RuleSendAuthorization;
  },
): MakaioNodeExtension<IMakaioBus> {
  const ruleBus = createCarrierBus(bus, { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND });
  return {
    ...automationTriggerBuiltinsPackage,
    dependencies: [
      ...(automationTriggerBuiltinsPackage.dependencies ?? []),
      dep(ReactionRegistryToken.name),
      dep(RuleContributionsToken.name),
    ],
    triggers: [busMessageTrigger],
    groupStrategies: [allGroupStrategy],
    lookups: [createHasRightLookup(rights.resolveLookupRight)],
    reactions: {
      createReactions: () => [createSendBusRequestReaction(ruleBus, rights.resolveRuleSendRight)],
    },
  };
}

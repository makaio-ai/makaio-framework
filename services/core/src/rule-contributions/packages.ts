import { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import { extensionToken, parseExtensionConfig, type MakaioNodeExtension } from '@makaio/contracts';
import { DEFAULT_CONTRIBUTION_VALIDATION_TIMEOUT_MS } from './contribution-validation.js';
import {
  RuleContributionsService,
  type RuleContributionsView,
  type RuleReactionRegistry,
} from './rule-contributions-service.js';

const RuleContributionsConfigSchema = z.object({
  validationTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(DEFAULT_CONTRIBUTION_VALIDATION_TIMEOUT_MS),
});

/** Token for the extension-facing rule discovery and contribution checks. */
export const RuleContributionsToken = extensionToken<RuleContributionsView>('rule-contributions');

/**
 * Creates the rule contributions package for a host.
 * @param reactions - Resolves the current host reaction registry.
 * @returns The package that starts the rule contributions service.
 */
export function createRuleContributionsPackage(
  reactions: () => RuleReactionRegistry | undefined,
): MakaioNodeExtension<IMakaioBus> {
  return {
    name: RuleContributionsToken.name,
    displayName: 'Rule Contributions',
    version: '0.1.0',
    critical: true,
    configSchema: RuleContributionsConfigSchema,
    create: (ctx) => {
      const { validationTimeoutMs } = parseExtensionConfig(RuleContributionsConfigSchema, ctx.config);
      return new RuleContributionsService(ctx.bus, reactions, ctx.hasExtension, validationTimeoutMs);
    },
  };
}

import { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import { extensionToken, parseExtensionConfig, type MakaioNodeExtension } from '@makaio/contracts';
import { ReactionRegistryToken } from '../reaction/packages.js';
import { DEFAULT_CONTRIBUTION_VALIDATION_TIMEOUT_MS } from './contribution-validation.js';
import { RuleContributionsService, type RuleContributionsView } from './rule-contributions-service.js';

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

/** Package that starts the framework rule contributions service. */
export const ruleContributionsPackage: MakaioNodeExtension<IMakaioBus> = {
  name: RuleContributionsToken.name,
  displayName: 'Rule Contributions',
  version: '0.1.0',
  critical: true,
  configSchema: RuleContributionsConfigSchema,
  create: (ctx) => {
    const { validationTimeoutMs } = parseExtensionConfig(RuleContributionsConfigSchema, ctx.config);
    return new RuleContributionsService(
      ctx.bus,
      () => ctx.getService(ReactionRegistryToken),
      ctx.hasExtension,
      validationTimeoutMs,
    );
  },
};

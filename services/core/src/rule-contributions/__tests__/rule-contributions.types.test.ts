import { expectTypeOf, it } from 'vitest';
import type { KernelExtensionContext } from '@makaio/kernel';
import { RuleContributionsToken } from '../packages.js';
import type { RuleContributionsService } from '../rule-contributions-service.js';

it('limits the service resolved by an extension to rule discovery and checks', () => {
  expectTypeOf((ctx: KernelExtensionContext) => ctx.getService(RuleContributionsToken)).returns.toEqualTypeOf<
    Readonly<Pick<RuleContributionsService, 'listTriggers' | 'listLookups' | 'validateRuleContributions'>> | undefined
  >();
});

import { expectTypeOf, it } from 'vitest';
import type { ExtensionToken } from '@makaio/contracts';
import type { RuleContributionsToken } from '../../rule-contributions/packages.js';
import type { ReactionRegistryToken } from '../packages.js';

type ExtensionReactionRegistry = typeof ReactionRegistryToken extends ExtensionToken<infer View> ? View : never;
type ExtensionRuleContributions = typeof RuleContributionsToken extends ExtensionToken<infer View> ? View : never;

it('reserves dispatch and executable rule metadata for the host', () => {
  expectTypeOf<ExtensionReactionRegistry>().not.toBeNever();
  expectTypeOf<Extract<'invoke' | 'ruleDefinition' | 'getValidator', keyof ExtensionReactionRegistry>>().toBeNever();
  expectTypeOf<Extract<'reaction', keyof ExtensionRuleContributions>>().toBeNever();
});

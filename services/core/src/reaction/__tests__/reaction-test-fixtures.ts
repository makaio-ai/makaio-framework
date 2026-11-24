import type { ReactionCause } from '@makaio/contracts/reaction';
import type { IMakaioBus } from '@makaio/bus-core';
import { type ReactionOutcome } from '@makaio/contracts';
import type { ReactionInvocationInput } from '../reaction-registry.js';

/**
 * Minimal `'accepted'` {@link ReactionOutcome}, shared by handler stubs whose
 * test only cares that the registry dispatched and not about the outcome's
 * content.
 */
export const ACCEPTED_OUTCOME: ReactionOutcome = { state: 'accepted' };

/**
 * Builds a minimal {@link ReactionCause} for tests: a schema-shaped but
 * otherwise arbitrary rule, evaluation, rule set, and occasion.
 * @param overrides - Fields to override on the default cause.
 * @returns A minimal cause reused across Reaction registry and processor tests.
 */
export function makeTestCause(overrides: Partial<ReactionCause> = {}): ReactionCause {
  return {
    ruleId: 'rule-1',
    evaluationId: 'evaluation-1',
    ruleSet: { id: 'set-1', digest: 'digest-1' },
    rule: {
      id: 'rule-1',
      description: 'Test rule.',
      on: { kind: 'test.trigger' },
      reaction: { kind: 'test.notify' },
    },
    event: {
      cause: { message: { receivedAt: new Date(0).toISOString() } },
      subject: 'test.subject',
      origin: {
        caller: { kind: 'makaio.extension', id: 'test' },
        principal: { kind: 'makaio.extension', id: 'test' },
      },
      facts: { value: 1 },
    },
    ...overrides,
  };
}

/**
 * Builds a minimal {@link ReactionInvocationInput} for tests.
 * @param bus - Bus used to mint the invocation's `CallContext` via `bus.own`.
 * @param overrides - Fields to override on the default input.
 * @returns Host-supplied invocation input reused across dispatch assertions.
 */
export function makeTestInvocationInput(
  bus: IMakaioBus,
  overrides: Partial<ReactionInvocationInput> = {},
): ReactionInvocationInput {
  return {
    call: bus.own('observer'),
    key: 'rule-1:occasion-1',
    cause: makeTestCause(),
    ...overrides,
  };
}

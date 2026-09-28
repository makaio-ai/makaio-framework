/**
 * Sync tests between the Claude Code client definition and the Claude Code
 * tool-response provider contract.
 *
 * The definition declares which hook events accept responses and which
 * response capabilities each carries; the contract declares which interactions
 * contributors may target and whether each can block. Contributor activation
 * validates against the contract, so an event or capability declared in the
 * definition but missing from the contract silently loses its contributors.
 * These tests derive the expectations from the definition so neither side can
 * drift without a failing test.
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES, clientDefinition } from '../../definition.js';
import { claudeCodeToolResponseContract, rendersDecision } from '../hook-response-contracts.js';

// ---------------------------------------------------------------------------
// Derived fixtures
// ---------------------------------------------------------------------------

/** Hook events from the real client definition that declare at least one response capability. */
const RESPONSE_CAPABLE_EVENTS = (clientDefinition.runtimeCapabilities?.hookEvents ?? []).filter(
  (event) => (event.responseCapabilities ?? []).length > 0,
);

/** Every response capability declared on any hook event, deduplicated. */
const DECLARED_CAPABILITIES = [
  ...new Set(RESPONSE_CAPABLE_EVENTS.flatMap((event) => event.responseCapabilities ?? [])),
];

/** Capabilities that carry a permission decision (approve/deny). */
const DECISION_CAPABILITIES: ReadonlySet<string> = new Set(Object.values(CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES));

/**
 * Collect the blockability entries the contract declares for an interaction.
 * @param interaction - Hook event name or capability name.
 * @returns All matching blockability entries.
 */
function blockabilityEntriesFor(interaction: string): readonly { interaction: string; blockable: boolean }[] {
  return claudeCodeToolResponseContract.blockability.filter((entry) => entry.interaction === interaction);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Claude Code hook response contract / definition sync', () => {
  it('derives a non-empty set of response-capable events from the definition', () => {
    expect(RESPONSE_CAPABLE_EVENTS.length).toBeGreaterThan(0);
    expect(DECLARED_CAPABILITIES.length).toBeGreaterThan(0);
  });

  describe.each(RESPONSE_CAPABLE_EVENTS.map((event) => [event.name, event] as const))('event %s', (name, event) => {
    it('is a supported interaction of the contract', () => {
      expect(claudeCodeToolResponseContract.supportedInteractions).toContain(name);
    });

    it('has exactly one blockability entry', () => {
      expect(blockabilityEntriesFor(name)).toHaveLength(1);
    });

    it('is blockable iff it declares a decision capability', () => {
      const declaresDecision = (event.responseCapabilities ?? []).some((capability) =>
        DECISION_CAPABILITIES.has(capability),
      );
      expect(blockabilityEntriesFor(name)[0]?.blockable).toBe(declaresDecision);
      expect(rendersDecision(name)).toBe(declaresDecision);
    });
  });

  describe.each(DECLARED_CAPABILITIES.map((capability) => [capability] as const))('capability %s', (capability) => {
    it('is a supported interaction of the contract', () => {
      expect(claudeCodeToolResponseContract.supportedInteractions).toContain(capability);
    });

    it('has exactly one blockability entry, blockable iff it is a decision capability', () => {
      const entries = blockabilityEntriesFor(capability);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.blockable).toBe(DECISION_CAPABILITIES.has(capability));
    });
  });

  it('declares PostToolUse as a context-only, non-blockable interaction', () => {
    const postToolUse = RESPONSE_CAPABLE_EVENTS.find((event) => event.name === 'PostToolUse');
    expect(postToolUse?.responseCapabilities).toContain('context.append');
    expect(claudeCodeToolResponseContract.supportedInteractions).toContain('PostToolUse');
    expect(blockabilityEntriesFor('PostToolUse')).toEqual([{ interaction: 'PostToolUse', blockable: false }]);
    expect(rendersDecision('PostToolUse')).toBe(false);
  });
});

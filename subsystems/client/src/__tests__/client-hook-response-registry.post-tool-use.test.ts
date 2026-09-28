/**
 * Activation-time validation of Claude Code `PostToolUse` contributors in
 * {@link ClientHookResponseRegistry}.
 *
 * A canonical event-name selector is accepted regardless of contract support,
 * so only a provider-lane selector proves that the contract declares
 * `PostToolUse`. The contract fixtures mirror the Claude Code tool-response
 * contract inline: `@makaio/subsystem-client` does not depend on
 * `@makaio/client-claude-code`, so the real catalog entry cannot be imported
 * here without inverting the package layering.
 */

import { describe, expect, it } from 'vitest';
import type {
  ContributorCallbackContext,
  ContributorDefinition,
  ProviderContractCatalogEntry,
} from '@makaio/contracts/client';
import { CANONICAL_HOOK_RESPONSE_CAPABILITIES, createAppendEffect } from '@makaio/contracts/client';
import { ClientHookProviderContractRegistry } from '../client-hook-provider-contract-registry.js';
import { ClientHookResponseRegistry } from '../client-hook-response-registry.js';

type ProviderContributorDefinition = Extract<ContributorDefinition, { lane: 'provider' }>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLIENT_ID = 'claude-code';
const CONTRACT_ID = 'claude-code.tool-response';

/**
 * Inline mirror of the Claude Code tool-response contract at `1.5.0`
 * (`clients/claude-code/src/runtime/hook-response-contracts.ts`).
 */
const CLAUDE_CONTRACT_1_5_0: ProviderContractCatalogEntry = {
  clientId: CLIENT_ID,
  contractId: CONTRACT_ID,
  version: '1.5.0',
  supportedInteractions: [
    'PreToolUse',
    'SessionStart',
    'UserPromptSubmit',
    'SubagentStart',
    'PostToolUse',
    'claude-code.tool-response.approve',
    'claude-code.tool-response.deny',
    CANONICAL_HOOK_RESPONSE_CAPABILITIES.contextAppend,
    CANONICAL_HOOK_RESPONSE_CAPABILITIES.sessionToken,
  ],
  blockability: [
    { interaction: 'PreToolUse', blockable: true },
    { interaction: 'claude-code.tool-response.approve', blockable: true },
    { interaction: 'claude-code.tool-response.deny', blockable: true },
    { interaction: 'SessionStart', blockable: false },
    { interaction: 'UserPromptSubmit', blockable: false },
    { interaction: 'SubagentStart', blockable: false },
    { interaction: 'PostToolUse', blockable: false },
    { interaction: CANONICAL_HOOK_RESPONSE_CAPABILITIES.contextAppend, blockable: false },
    { interaction: CANONICAL_HOOK_RESPONSE_CAPABILITIES.sessionToken, blockable: false },
  ],
  validate: () => true,
};

/** The same contract as it stood at `1.4.0`, before `PostToolUse` was declared. */
const CLAUDE_CONTRACT_1_4_0: ProviderContractCatalogEntry = {
  ...CLAUDE_CONTRACT_1_5_0,
  version: '1.4.0',
  supportedInteractions: CLAUDE_CONTRACT_1_5_0.supportedInteractions.filter((i) => i !== 'PostToolUse'),
  blockability: CLAUDE_CONTRACT_1_5_0.blockability.filter((b) => b.interaction !== 'PostToolUse'),
};

/**
 * Respond callback appending context to the tool result.
 * @param _ctx - Ignored callback context.
 * @returns A canonical `context.append` contribution.
 */
const appendRespond = (_ctx: ContributorCallbackContext) => ({
  canonicalEffects: [createAppendEffect('post-tool-use context')],
});

/**
 * Create a provider-lane Claude Code `PostToolUse` contributor that appends context.
 * @param overrides - Partial overrides for the contributor definition.
 * @returns A complete provider contributor definition.
 */
function createPostToolUseContributor(
  overrides: Partial<ProviderContributorDefinition> = {},
): ProviderContributorDefinition {
  return {
    id: 'post-tool-use-append',
    lane: 'provider',
    clientId: CLIENT_ID,
    contractId: CONTRACT_ID,
    priority: 100,
    timeoutMs: 5000,
    selectors: [
      { kind: 'event-name', name: 'PostToolUse' },
      { kind: 'capability', capability: CANONICAL_HOOK_RESPONSE_CAPABILITIES.contextAppend },
    ],
    respond: appendRespond,
    ...overrides,
  };
}

/**
 * Build a response registry backed by one registered provider contract.
 * @param contract - Provider contract to register.
 * @returns A fresh response registry.
 */
function createRegistry(contract: ProviderContractCatalogEntry): ClientHookResponseRegistry {
  const contractRegistry = new ClientHookProviderContractRegistry();
  contractRegistry.registerProviderContract('ext-claude-code', contract);
  return new ClientHookResponseRegistry(contractRegistry);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientHookResponseRegistry — Claude Code PostToolUse', () => {
  it('accepts a provider-lane PostToolUse context.append contributor with open policy', () => {
    const registry = createRegistry(CLAUDE_CONTRACT_1_5_0);

    const result = registry.installContributors('ext-a', [createPostToolUseContributor()]);

    expect(result.errors).toEqual([]);
    expect(registry.snapshot(CLIENT_ID, CONTRACT_ID, 'PostToolUse')).toHaveLength(1);
  });

  it('rejects a provider-lane PostToolUse contributor with closed policy as non-blockable', () => {
    const registry = createRegistry(CLAUDE_CONTRACT_1_5_0);

    const result = registry.installContributors('ext-a', [createPostToolUseContributor({ failurePolicy: 'closed' })]);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((error) => error.code === 'closed-policy-on-non-blockable')).toBe(true);
    expect(result.errors.some((error) => error.message.includes("'PostToolUse' is not blockable"))).toBe(true);
    expect(registry.snapshot(CLIENT_ID, CONTRACT_ID, 'PostToolUse')).toHaveLength(0);
  });

  it('rejects a provider-lane PostToolUse contributor against a contract without PostToolUse', () => {
    const registry = createRegistry(CLAUDE_CONTRACT_1_4_0);

    const result = registry.installContributors('ext-a', [createPostToolUseContributor()]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('unsupported-interaction');
    expect(result.errors[0].message).toContain("'PostToolUse'");
    expect(registry.snapshot(CLIENT_ID, CONTRACT_ID, 'PostToolUse')).toHaveLength(0);
  });
});

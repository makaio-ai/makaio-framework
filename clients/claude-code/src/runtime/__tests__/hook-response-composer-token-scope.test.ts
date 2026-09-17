/**
 * Token scope edge-case tests for the Claude Code hook response composer.
 *
 * Covers residual scope rules after the SubagentStart capability removal:
 * - `SubagentStart` never calls the sink because `session.token` is not
 *   declared for that event (the capability-selected contributor is skipped).
 * - `SessionStart` must not adopt a stray `agent_id` from the payload.
 *
 * Kept in a sibling file so `hook-response-composer.test.ts` stays under 800
 * lines.
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { ClientHookProviderContractRegistry, ClientHookResponseRegistry } from '@makaio/subsystem-client';
import type { ContributorDefinition } from '@makaio/contracts/client';
import { createSessionTokenEffect } from '@makaio/contracts/client';
import { composeHookResponse } from '../hook-response-composer.js';
import { claudeCodeToolResponseContract } from '../hook-response-contracts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_EXTENSION = 'test-token-scope';

function createRegistries(): {
  contractRegistry: ClientHookProviderContractRegistry;
  responseRegistry: ClientHookResponseRegistry;
} {
  const contractRegistry = new ClientHookProviderContractRegistry();
  const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
  contractRegistry.registerProviderContract(TEST_EXTENSION, claudeCodeToolResponseContract);
  return { contractRegistry, responseRegistry };
}

function installContributor(responseRegistry: ClientHookResponseRegistry, definition: ContributorDefinition): void {
  const result = responseRegistry.installContributors(TEST_EXTENSION, [definition]);
  expect(result.errors).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('composeHookResponse — session.token scope rules', () => {
  it('does not call the sink on SubagentStart — session.token is not declared for that event', async () => {
    // SubagentStart no longer declares session.token. Claude Code subagents
    // share the parent session's stdio MCP servers, which receive only
    // CLAUDE_CODE_SESSION_ID and have no path to the hook-only agent_id.
    // A token stored under (clientId, adapterSessionId, agentId) can therefore
    // never be retrieved. The capability-selected contributor is not matched
    // for SubagentStart events — the sink must not be called regardless of
    // whether agent_id is present in the payload.
    const { responseRegistry } = createRegistries();
    const received: string[] = [];

    installContributor(responseRegistry, {
      lane: 'canonical',
      clientIds: ['claude-code'],
      id: 'token-subagent-no-id',
      priority: 100,
      timeoutMs: 5000,
      selectors: [{ kind: 'capability', capability: 'session.token' }],
      respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-orphan')] }),
    });

    await composeHookResponse(
      responseRegistry,
      {
        eventName: 'SubagentStart',
        receivedAt: Date.now(),
        payload: { session_id: 'sess-parent' },
      },
      {
        onSessionToken: (token) => {
          received.push(token);
        },
      },
    );

    expect(received).toHaveLength(0);
  });

  it('ignores stray agent_id on SessionStart (scope is session-only)', async () => {
    const { responseRegistry } = createRegistries();
    const received: Array<{ token: string; scope: { clientId: string; adapterSessionId: string; agentId?: string } }> =
      [];

    installContributor(responseRegistry, {
      lane: 'canonical',
      clientIds: ['claude-code'],
      id: 'token-session-stray-agent',
      priority: 100,
      timeoutMs: 5000,
      selectors: [{ kind: 'capability', capability: 'session.token' }],
      respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-stray')] }),
    });

    // SessionStart payload with a stray agent_id: the sink is called, but
    // the scope must contain only adapterSessionId (no agentId key).
    await composeHookResponse(
      responseRegistry,
      {
        eventName: 'SessionStart',
        receivedAt: Date.now(),
        payload: { session_id: 'sess-main', agent_id: 'stray-id', source: 'startup' },
      },
      {
        onSessionToken: (token, scope) => {
          received.push({ token, scope });
        },
      },
    );

    expect(received).toHaveLength(1);
    expect(received[0]!.scope.clientId).toBe('claude-code');
    expect(received[0]!.scope.adapterSessionId).toBe('sess-main');
    expect('agentId' in received[0]!.scope).toBe(false);
  });
});

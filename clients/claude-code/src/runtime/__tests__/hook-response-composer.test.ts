/**
 * Tests for the Claude Code hook response composer.
 *
 * Verifies the full composition pipeline: snapshot, collect, reduce, and
 * serialize for `PreToolUse` interactions.  Also covers edge cases: no
 * contributors, observer-only events, closed failures, deny-over-approve
 * precedence, and context.append concatenation.
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { ClientHookProviderContractRegistry, ClientHookResponseRegistry } from '@makaio/subsystem-client';
import type { ContributorDefinition } from '@makaio/contracts/client';
import { createAppendEffect, createSessionTokenEffect } from '@makaio/contracts/client';
import { composeHookResponse } from '../hook-response-composer.js';
import { claudeCodeToolResponseContract, createApproveEffect, createDenyEffect } from '../hook-response-contracts.js';
import { CLAUDE_CODE_HOOK_PRE_TOOL_USE } from '../schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extension ID used for all test contributor registrations. */
const TEST_EXTENSION = 'test-extension';

/**
 * Parse the stdout JSON from a hook handle response.
 * @param stdout - JSON string from the response stdout.
 * @returns Parsed hook specific output.
 */
function parsePreToolUseOutput(stdout: string): {
  hookEventName: string;
  permissionDecision: string;
  permissionDecisionReason?: string;
  additionalContext?: string;
} {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason?: string;
      additionalContext?: string;
    };
  };
  return parsed.hookSpecificOutput;
}

/**
 * Create a raw hook payload for PreToolUse.
 * @param toolName - Name of the tool being used.
 * @returns Raw hook payload.
 */
function makePreToolUsePayload(toolName = 'bash'): {
  eventName: string;
  receivedAt: number;
  payload: Record<string, unknown>;
} {
  return {
    eventName: CLAUDE_CODE_HOOK_PRE_TOOL_USE,
    receivedAt: Date.now(),
    payload: {
      session_id: 'sess-test-001',
      tool_name: toolName,
      tool_use_id: 'tu-test-001',
      tool_input: { command: 'echo hello' },
    },
  };
}

/**
 * Create a registry pair with the Claude Code tool-response contract
 * already registered.
 * @returns Provider contract registry and hook response registry.
 */
function createRegistries(): {
  contractRegistry: ClientHookProviderContractRegistry;
  responseRegistry: ClientHookResponseRegistry;
} {
  const contractRegistry = new ClientHookProviderContractRegistry();
  const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
  contractRegistry.registerProviderContract(TEST_EXTENSION, claudeCodeToolResponseContract);
  return { contractRegistry, responseRegistry };
}

/**
 * Install a contributor in the response registry.
 * @param responseRegistry - The response registry.
 * @param definition - The contributor definition.
 */
function installContributor(responseRegistry: ClientHookResponseRegistry, definition: ContributorDefinition): void {
  const result = responseRegistry.installContributors(TEST_EXTENSION, [definition]);
  expect(result.errors).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('composeHookResponse', () => {
  describe('no contributors', () => {
    it('returns no-op when no contributors are registered', async () => {
      const { responseRegistry } = createRegistries();
      const payload = makePreToolUsePayload();

      const result = await composeHookResponse(responseRegistry, payload);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  describe('approve effect', () => {
    it('returns allow decision when a contributor approves', async () => {
      const { responseRegistry } = createRegistries();
      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'approver',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createApproveEffect('Tool approved by policy'),
        }),
      });
      const payload = makePreToolUsePayload();

      const result = await composeHookResponse(responseRegistry, payload);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const output = parsePreToolUseOutput(result.stdout);
      expect(output.hookEventName).toBe('PreToolUse');
      expect(output.permissionDecision).toBe('allow');
      expect(output.permissionDecisionReason).toBe('Tool approved by policy');
    });
  });

  describe('deny effect', () => {
    it('returns deny decision when a contributor denies', async () => {
      const { responseRegistry } = createRegistries();
      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'denier',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createDenyEffect('Tool denied by security policy'),
        }),
      });
      const payload = makePreToolUsePayload();

      const result = await composeHookResponse(responseRegistry, payload);

      expect(result.exitCode).toBe(0);
      const output = parsePreToolUseOutput(result.stdout);
      expect(output.permissionDecision).toBe('deny');
      expect(output.permissionDecisionReason).toBe('Tool denied by security policy');
    });
  });

  describe('deny over approve precedence', () => {
    it('deny wins when both approve and deny are contributed', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'approver',
        priority: 200,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createApproveEffect('Looks safe'),
        }),
      });

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'denier',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createDenyEffect('Denied by compliance'),
        }),
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      const output = parsePreToolUseOutput(result.stdout);
      expect(output.permissionDecision).toBe('deny');
      // Both reasons are included
      expect(output.permissionDecisionReason).toContain('Looks safe');
      expect(output.permissionDecisionReason).toContain('Denied by compliance');
    });
  });

  describe('context.append', () => {
    it('appends context from canonical effects', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'context-adder',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'context.append' }],
        respond: () => ({
          canonicalEffects: [createAppendEffect('Additional context from extension')],
        }),
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      const output = parsePreToolUseOutput(result.stdout);
      // When only context.append is contributed (no explicit decision),
      // the default decision is 'allow'
      expect(output.permissionDecision).toBe('allow');
      expect(output.additionalContext).toBe('Additional context from extension');
    });

    it('concatenates multiple context.append values with newlines', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'context-adder-1',
        priority: 200,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'context.append' }],
        respond: () => ({
          canonicalEffects: [createAppendEffect('First context line')],
        }),
      });

      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'context-adder-2',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'context.append' }],
        respond: () => ({
          canonicalEffects: [createAppendEffect('Second context line')],
        }),
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      const output = parsePreToolUseOutput(result.stdout);
      expect(output.additionalContext).toBe('First context line\nSecond context line');
    });
  });

  describe('combined decision and context', () => {
    it('combines a deny decision with appended context', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'denier',
        priority: 200,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createDenyEffect('Forbidden'),
        }),
      });

      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'context-adder',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'context.append' }],
        respond: () => ({
          canonicalEffects: [createAppendEffect('Extra safety note')],
        }),
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      const output = parsePreToolUseOutput(result.stdout);
      expect(output.permissionDecision).toBe('deny');
      // Permission reason and additional context remain separate native fields.
      expect(output.permissionDecisionReason).toContain('Forbidden');
      expect(output.additionalContext).toContain('Extra safety note');
    });
  });

  describe('no-op contributor', () => {
    it('returns no-op when contributor responds with undefined', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'noop-contributor',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => undefined,
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  describe('closed failure on block-capable interaction', () => {
    it('converts closed failure to deny on PreToolUse', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'closed-contributor',
        priority: 100,
        timeoutMs: 50,
        failurePolicy: 'closed',
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => {
          throw new Error('Critical failure');
        },
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      expect(result.exitCode).toBe(0);
      const output = parsePreToolUseOutput(result.stdout);
      expect(output.permissionDecision).toBe('deny');
      expect(output.permissionDecisionReason).toContain('Critical failure');
    });

    it('discards all effects when closed failure occurs', async () => {
      const { responseRegistry } = createRegistries();

      // A contributor that succeeds with an approve
      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'approver',
        priority: 200,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createApproveEffect('Approved'),
        }),
      });

      // A contributor that fails with closed policy
      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'closed-failure',
        priority: 100,
        timeoutMs: 50,
        failurePolicy: 'closed',
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => {
          throw new Error('Compliance check failed');
        },
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      const output = parsePreToolUseOutput(result.stdout);
      // Closed failure converts to deny — the approve effect is discarded
      expect(output.permissionDecision).toBe('deny');
      expect(output.permissionDecisionReason).toContain('Compliance check failed');
    });
  });

  describe('observer-only events', () => {
    it('returns no-op for observer-only events with no matching contributors', async () => {
      const { responseRegistry } = createRegistries();
      const payload = {
        eventName: 'SessionStart',
        receivedAt: Date.now(),
        payload: { session_id: 'sess-test-001' },
      };

      const result = await composeHookResponse(responseRegistry, payload);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  describe('SessionStart', () => {
    /**
     * Build a native SessionStart hook payload.
     * @returns Raw payload shaped like the probe-captured SessionStart event.
     */
    function sessionStartPayload() {
      return {
        eventName: 'SessionStart',
        receivedAt: Date.now(),
        payload: { session_id: 'sess-test-001', source: 'startup' },
      };
    }

    it('renders appended context without a permission decision', async () => {
      const { responseRegistry } = createRegistries();
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'session-context',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'SessionStart' }],
        respond: () => ({ canonicalEffects: [createAppendEffect('repo conventions')] }),
      });

      const result = await composeHookResponse(responseRegistry, sessionStartPayload());

      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'repo conventions' },
      });
    });

    it('rejects the contributor when a permission decision cannot be rendered', async () => {
      const { responseRegistry } = createRegistries();
      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'misplaced-decision',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'SessionStart' }],
        respond: () => ({ providerEnvelope: createApproveEffect() }),
      });

      const diagnostics: Array<{ contributorId: string; message: string }> = [];
      const result = await composeHookResponse(responseRegistry, sessionStartPayload(), {
        onDiagnostics: (entries) => diagnostics.push(...entries),
      });

      // The envelope is well-formed, so only the event name makes it wrong. The
      // contract validator sees the event and rejects it there, rather than
      // letting reduction drop the decision on the floor unannounced.
      expect(result.stdout).toBe('');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.contributorId).toContain('misplaced-decision');
      expect(diagnostics[0]!.message).toContain('not renderable');
    });
  });

  describe('capability selectors', () => {
    it('matches contributors using capability selectors', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'deny-capability',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'claude-code.tool-response.deny' }],
        respond: () => ({
          providerEnvelope: createDenyEffect('Denied via capability selector'),
        }),
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      const output = parsePreToolUseOutput(result.stdout);
      expect(output.permissionDecision).toBe('deny');
      expect(output.permissionDecisionReason).toBe('Denied via capability selector');
    });
  });

  describe('multiple approve contributors', () => {
    it('combines reasons from multiple approving contributors', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'approver-1',
        priority: 200,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createApproveEffect('Reason A'),
        }),
      });

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'approver-2',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createApproveEffect('Reason B'),
        }),
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      const output = parsePreToolUseOutput(result.stdout);
      expect(output.permissionDecision).toBe('allow');
      expect(output.permissionDecisionReason).toContain('Reason A');
      expect(output.permissionDecisionReason).toContain('Reason B');
    });
  });

  describe('approve with no reason', () => {
    it('returns allow without reason when no reason is provided', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'silent-approver',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({
          providerEnvelope: createApproveEffect(),
        }),
      });

      const payload = makePreToolUsePayload();
      const result = await composeHookResponse(responseRegistry, payload);

      const output = parsePreToolUseOutput(result.stdout);
      expect(output.permissionDecision).toBe('allow');
      expect(output.permissionDecisionReason).toBeUndefined();
    });
  });

  describe('provider contract validation', () => {
    it('accepts exact envelopes and rejects unknown envelope or effect fields', () => {
      const context = { eventName: 'PreToolUse' };
      expect(claudeCodeToolResponseContract.validate({ providerEnvelope: createApproveEffect('safe') }, context)).toBe(
        true,
      );
      expect(
        claudeCodeToolResponseContract.validate(
          {
            providerEnvelope: {
              ...createDenyEffect('unsafe'),
              unexpected: true,
            },
          },
          context,
        ),
      ).toContain("Unsupported Claude Code providerEnvelope field 'unexpected'");
      expect(
        claudeCodeToolResponseContract.validate(
          {
            providerEnvelope: {
              clientId: 'claude-code',
              contractId: 'claude-code.tool-response',
              effects: { decision: 'deny', reason: 'unsafe', unexpected: true },
            },
          },
          context,
        ),
      ).toContain("Unsupported Claude Code PreToolUse effect 'unexpected'");
    });

    it('accepts an identical decision on a blockable event and rejects it elsewhere', () => {
      const envelope = { providerEnvelope: createDenyEffect('unsafe') };

      // Same payload, different event: the contract spans blockable and
      // non-blockable interactions, so shape alone cannot decide validity.
      expect(claudeCodeToolResponseContract.validate(envelope, { eventName: 'PreToolUse' })).toBe(true);
      expect(claudeCodeToolResponseContract.validate(envelope, { eventName: 'SessionStart' })).toContain(
        "Permission decisions are not renderable on 'SessionStart'",
      );
    });

    it('still accepts an empty response on an event that renders no decision', () => {
      expect(claudeCodeToolResponseContract.validate(undefined, { eventName: 'SessionStart' })).toBe(true);
      expect(claudeCodeToolResponseContract.validate({}, { eventName: 'SessionStart' })).toBe(true);
    });
  });

  describe('session.token', () => {
    /**
     * Build a raw SessionStart payload with the given session id.
     * @param sessionId - Value for the `session_id` field.
     * @returns Raw hook payload shaped like a live SessionStart event.
     */
    function makeSessionStartPayload(sessionId = 'sess-token-001') {
      return {
        eventName: 'SessionStart',
        receivedAt: Date.now(),
        payload: { session_id: sessionId, source: 'startup' },
      };
    }

    /**
     * Build a raw SubagentStart payload with the given session and agent ids.
     * @param sessionId - Value for the `session_id` field.
     * @param agentId - Value for the `agent_id` field.
     * @returns Raw hook payload shaped like a live SubagentStart event.
     */
    function makeSubagentStartPayload(sessionId = 'sess-token-001', agentId = 'agent-001') {
      return {
        eventName: 'SubagentStart',
        receivedAt: Date.now(),
        payload: { session_id: sessionId, agent_id: agentId },
      };
    }

    it('calls onSessionToken with scope and token when SessionStart contributes a token', async () => {
      const { responseRegistry } = createRegistries();
      const received: Array<{
        token: string;
        scope: { clientId: string; adapterSessionId: string; agentId?: string };
      }> = [];

      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'token-contributor',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'session.token' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-abc-123')] }),
      });

      const result = await composeHookResponse(responseRegistry, makeSessionStartPayload('sess-abc'), {
        onSessionToken: (token, scope) => {
          received.push({ token, scope });
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.token).toBe('tok-abc-123');
      expect(received[0]!.scope.clientId).toBe('claude-code');
      expect(received[0]!.scope.adapterSessionId).toBe('sess-abc');
      expect(received[0]!.scope.agentId).toBeUndefined();
      // Token must never appear in stdout.
      expect(result.stdout).not.toContain('tok-abc-123');
    });

    it('does not write token to stdout on SessionStart', async () => {
      const { responseRegistry } = createRegistries();

      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'token-and-context',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'session.token' }],
        respond: () => ({
          canonicalEffects: [createSessionTokenEffect('tok-secret'), createAppendEffect('visible context')],
        }),
      });

      const result = await composeHookResponse(responseRegistry, makeSessionStartPayload(), {
        onSessionToken: () => undefined,
      });

      // Context appears in stdout; token does not.
      expect(result.stdout).toContain('visible context');
      expect(result.stdout).not.toContain('tok-secret');
    });

    it('does not call sink on SubagentStart — session.token is not declared for that event', async () => {
      // SubagentStart no longer declares session.token. Claude Code subagents
      // share the parent session's stdio MCP servers which receive only
      // CLAUDE_CODE_SESSION_ID; they have no path to the hook-only agent_id,
      // so a token stored under (clientId, adapterSessionId, agentId) could
      // never be retrieved. The capability-selected contributor must not fire
      // for SubagentStart events.
      const { responseRegistry } = createRegistries();
      const received: string[] = [];

      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'subagent-token',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'session.token' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-subagent-xyz')] }),
      });

      await composeHookResponse(responseRegistry, makeSubagentStartPayload('sess-parent', 'agent-child'), {
        onSessionToken: (token) => {
          received.push(token);
        },
      });

      expect(received).toHaveLength(0);
    });

    it('drops session.token effect when event does not declare the capability', async () => {
      const { responseRegistry } = createRegistries();
      const received: string[] = [];

      // Canonical contributor matched by PreToolUse event name, returning a
      // session.token effect. PreToolUse has no session.token capability, so
      // composeHookResponse must not invoke the sink.
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'token-on-pre-tool-use',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: CLAUDE_CODE_HOOK_PRE_TOOL_USE }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-should-drop')] }),
      });

      await composeHookResponse(responseRegistry, makePreToolUsePayload(), {
        onSessionToken: (token) => {
          received.push(token);
        },
      });

      expect(received).toHaveLength(0);
    });

    it('highest-priority contributor token wins when multiple contributors deliver tokens', async () => {
      const { responseRegistry } = createRegistries();
      let capturedToken: string | undefined;

      // Priority 200 — highest: this token must win.
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'high-priority-token',
        priority: 200,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'session.token' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-high')] }),
      });

      // Priority 100 — lower: this token must be discarded.
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'low-priority-token',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'session.token' }],
        respond: () => ({ canonicalEffects: [createSessionTokenEffect('tok-low')] }),
      });

      await composeHookResponse(responseRegistry, makeSessionStartPayload(), {
        onSessionToken: (token) => {
          capturedToken = token;
        },
      });

      expect(capturedToken).toBe('tok-high');
    });
  });
});

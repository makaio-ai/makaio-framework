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
import { createAppendEffect } from '@makaio/contracts/client';
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
  });
});

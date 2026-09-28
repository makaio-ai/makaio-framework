/**
 * Tests for context-only rendering in the Claude Code hook response composer.
 *
 * `PostToolUse` declares `context.append` alone and cannot block, so it renders
 * appended context without any decision field. `PreToolUse` keeps its decision
 * path: a real approve still renders `permissionDecision` next to the context.
 * Split from `hook-response-composer.test.ts` to keep that file under the
 * size limit.
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { ClientHookProviderContractRegistry, ClientHookResponseRegistry } from '@makaio/subsystem-client';
import type { ContributorDefinition } from '@makaio/contracts/client';
import { createAppendEffect } from '@makaio/contracts/client';
import { composeHookResponse } from '../hook-response-composer.js';
import { claudeCodeToolResponseContract, createApproveEffect } from '../hook-response-contracts.js';
import { CLAUDE_CODE_HOOK_POST_TOOL_USE, CLAUDE_CODE_HOOK_PRE_TOOL_USE } from '../schemas.js';

// Deliberate local copy of the shared composer test helpers: the shared
// composer test files stay untouched here, and extraction would widen test coupling.

/** Extension ID used for all test contributor registrations. */
const TEST_EXTENSION = 'test-extension';

/**
 * Create a hook response registry with the Claude Code tool-response contract
 * already registered.
 * @returns The hook response registry.
 */
function createResponseRegistry(): ClientHookResponseRegistry {
  const contractRegistry = new ClientHookProviderContractRegistry();
  const responseRegistry = new ClientHookResponseRegistry(contractRegistry);
  contractRegistry.registerProviderContract(TEST_EXTENSION, claudeCodeToolResponseContract);
  return responseRegistry;
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

/**
 * Build a native tool hook payload for the given event.
 * @param eventName - Native Claude Code hook event name.
 * @returns Raw hook payload shaped like a live tool hook event.
 */
function toolPayload(eventName: string) {
  return {
    eventName,
    receivedAt: Date.now(),
    payload: {
      session_id: 'sess-test-001',
      tool_name: 'bash',
      tool_use_id: 'tu-test-001',
      tool_input: { command: 'echo hello' },
    },
  };
}

describe('composeHookResponse', () => {
  describe('PreToolUse decision with context', () => {
    it('renders an explicit approve together with appended context', async () => {
      const responseRegistry = createResponseRegistry();
      installContributor(responseRegistry, {
        lane: 'provider',
        clientId: 'claude-code',
        contractId: 'claude-code.tool-response',
        id: 'approver',
        priority: 200,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        respond: () => ({ providerEnvelope: createApproveEffect() }),
      });
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'context-adder',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'capability', capability: 'context.append' }],
        respond: () => ({ canonicalEffects: [createAppendEffect('tool guidance')] }),
      });

      const result = await composeHookResponse(responseRegistry, toolPayload(CLAUDE_CODE_HOOK_PRE_TOOL_USE));

      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: 'tool guidance',
        },
      });
    });
  });

  describe('PostToolUse', () => {
    it('renders appended context without any decision field', async () => {
      const responseRegistry = createResponseRegistry();
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'post-tool-context',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PostToolUse' }],
        respond: () => ({ canonicalEffects: [createAppendEffect('tool result note')] }),
      });

      const result = await composeHookResponse(responseRegistry, toolPayload(CLAUDE_CODE_HOOK_POST_TOOL_USE));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      // Exact equality also proves the absence of `permissionDecision` and a
      // top-level `decision`: PostToolUse is context-only and non-blockable.
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'tool result note' },
      });
    });

    it('returns the no-op response when no contributors are registered', async () => {
      const responseRegistry = createResponseRegistry();

      const result = await composeHookResponse(responseRegistry, toolPayload(CLAUDE_CODE_HOOK_POST_TOOL_USE));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('returns the no-op response when an open-policy contributor fails', async () => {
      const responseRegistry = createResponseRegistry();
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'failing-post-tool',
        priority: 100,
        timeoutMs: 50,
        failurePolicy: 'open',
        selectors: [{ kind: 'event-name', name: 'PostToolUse' }],
        respond: () => {
          throw new Error('post-tool contributor failed');
        },
      });

      const result = await composeHookResponse(responseRegistry, toolPayload(CLAUDE_CODE_HOOK_POST_TOOL_USE));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('still renders sibling context when one open-policy contributor fails', async () => {
      const responseRegistry = createResponseRegistry();
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'failing-post-tool',
        priority: 200,
        timeoutMs: 50,
        failurePolicy: 'open',
        selectors: [{ kind: 'event-name', name: 'PostToolUse' }],
        respond: () => {
          throw new Error('post-tool contributor failed');
        },
      });
      installContributor(responseRegistry, {
        lane: 'canonical',
        clientIds: ['claude-code'],
        id: 'post-tool-context',
        priority: 100,
        timeoutMs: 5000,
        selectors: [{ kind: 'event-name', name: 'PostToolUse' }],
        respond: () => ({ canonicalEffects: [createAppendEffect('tool result note')] }),
      });

      const result = await composeHookResponse(responseRegistry, toolPayload(CLAUDE_CODE_HOOK_POST_TOOL_USE));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'tool result note' },
      });
    });
  });
});

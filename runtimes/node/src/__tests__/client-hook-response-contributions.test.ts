/**
 * End-to-end proofs for client hook response contributions.
 *
 * These tests boot the public extension composition path: clients-core,
 * provider runtime packages, external extensions, and the client `hook.handle`
 * request handler. They deliberately do not construct private registries.
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { dep } from '@makaio/contracts';
import { createAppendEffect, type ContributorDefinition } from '@makaio/contracts/client';
import type { KernelMakaioExtension } from '@makaio/kernel';
import { ExtensionCoordinator } from '@makaio/kernel';
import {
  claudeCodeClientRuntimePackage,
  ClaudeCodeClientSubjects,
  CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
  createApproveEffect,
  createDenyEffect,
} from '@makaio/client-claude-code/runtime';
import { codexClientRuntimePackage, CODEX_CONTRACT_ID } from '@makaio/client-codex/runtime';
import { ClientsCoreToken, createClientsCorePackage } from '@makaio/subsystem-client';

import { registerExtensionBootContributions } from '../boot.js';

const TEST_MAKAIO_HOME = '/home/test/.makaio';
const CLAUDE_CLIENT_ID = 'claude-code';

/**
 * Build the raw request sent by a Claude Code hook bridge.
 * @param toolName - Client-native tool identifier.
 */
function hookRequest(toolName = 'bash') {
  return {
    eventName: 'PreToolUse',
    receivedAt: Date.now(),
    payload: {
      session_id: 'session-42',
      tool_name: toolName,
      tool_use_id: 'tool-99',
      tool_input: { command: 'echo hello' },
    },
  };
}

/**
 * Parse the public native hook response shape.
 * @param stdout - Serialized client-native response.
 */
function responseOutput(stdout: string): {
  permissionDecision: string;
  permissionDecisionReason?: string;
  additionalContext?: string;
} {
  const output = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string; additionalContext?: string };
  };
  return output.hookSpecificOutput;
}

/**
 * Create an external extension using the public contribution contract.
 * @param name - Extension identity.
 * @param contributors - Factory for the extension's contributor batch.
 */
function externalExtension(name: string, contributors: () => ContributorDefinition[]): KernelMakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    dependencies: [dep('claude-code.runtime')],
    clientHookResponses: { createContributors: contributors },
  };
}

/**
 * Start the same public extension composition used by the node runtime.
 * @param extensions - External extensions under test.
 * @param includeCodex - Whether to activate the Codex provider contract too.
 */
async function startRuntime(
  extensions: readonly KernelMakaioExtension[],
  includeCodex = false,
): Promise<{
  readonly bus: IMakaioBus;
  readonly coordinator: ExtensionCoordinator;
}> {
  const bus = createBusInstance();
  const coordinator = new ExtensionCoordinator(bus, {
    extensionContextBase: {
      platform: process.platform,
      homedir: '/home/test',
      makaioHome: TEST_MAKAIO_HOME,
      username: 'test',
      machineId: 'machine-1',
      busUrl: 'ws://127.0.0.1:0/bus',
      tryImport: async () => null,
    },
  });
  const packages = [
    createClientsCorePackage(),
    claudeCodeClientRuntimePackage,
    ...(includeCodex ? [codexClientRuntimePackage] : []),
    ...extensions,
  ];
  coordinator.load(packages);
  registerExtensionBootContributions(packages, bus, coordinator);
  await coordinator.startAll();
  return { bus, coordinator };
}

/**
 * Read a registry snapshot through the public clients-core service.
 * @param coordinator - Active public extension coordinator.
 * @param clientId - Receiving client identity.
 * @param contractId - Active provider contract identity.
 */
function snapshot(
  coordinator: ExtensionCoordinator,
  clientId = CLAUDE_CLIENT_ID,
  contractId = CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
) {
  const clientsCore = coordinator.getExtensionService(ClientsCoreToken);
  expect(clientsCore).toBeDefined();
  return clientsCore!.hookResponseRegistry.snapshot(clientId, contractId, 'PreToolUse', [
    'approve',
    'deny',
    'context.append',
  ]);
}

describe('client hook response contributions', () => {
  it('composes canonical-only, provider-only, and mixed lanes through hook.handle', async () => {
    const runtime = await startRuntime([
      externalExtension('canonical', () => [
        {
          lane: 'canonical',
          id: 'context',
          priority: 300,
          timeoutMs: 500,
          selectors: [{ kind: 'capability', capability: 'context.append' }],
          respond: () => ({ canonicalEffects: [createAppendEffect('portable context')] }),
        },
      ]),
      externalExtension('provider', () => [
        {
          lane: 'provider',
          clientId: CLAUDE_CLIENT_ID,
          contractId: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
          id: 'approve',
          priority: 200,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => ({ providerEnvelope: createApproveEffect('provider approval') }),
        },
      ]),
      externalExtension('mixed', () => [
        {
          lane: 'canonical',
          clientIds: [CLAUDE_CLIENT_ID],
          id: 'targeted-context',
          priority: 100,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => ({ canonicalEffects: [createAppendEffect('targeted context')] }),
        },
      ]),
    ]);
    try {
      expect(snapshot(runtime.coordinator)).toHaveLength(3);
      const result = await runtime.bus.request(ClaudeCodeClientSubjects.hook.handle, hookRequest());
      const output = responseOutput(result.stdout);
      expect(output.permissionDecision).toBe('allow');
      expect(output.permissionDecisionReason).toBe('provider approval');
      expect(output.additionalContext).toBe('portable context\ntargeted context');
    } finally {
      await runtime.coordinator.shutdown();
    }
  });

  it('isolates provider contracts and client-targeted canonical contributors', async () => {
    const runtime = await startRuntime(
      [
        externalExtension('claude-only', () => [
          {
            lane: 'provider',
            clientId: CLAUDE_CLIENT_ID,
            contractId: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
            id: 'deny',
            priority: 100,
            timeoutMs: 500,
            selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
            respond: () => ({ providerEnvelope: createDenyEffect('Claude only') }),
          },
          {
            lane: 'canonical',
            clientIds: [CLAUDE_CLIENT_ID],
            id: 'context',
            priority: 100,
            timeoutMs: 500,
            selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
            respond: () => ({ canonicalEffects: [createAppendEffect('Claude context')] }),
          },
        ]),
      ],
      true,
    );
    try {
      expect(snapshot(runtime.coordinator)).toHaveLength(2);
      expect(snapshot(runtime.coordinator, 'codex', CODEX_CONTRACT_ID)).toHaveLength(0);
    } finally {
      await runtime.coordinator.shutdown();
    }
  });

  it('keeps failed activation atomic and resolves conflicting provider effects deterministically', async () => {
    const runtime = await startRuntime([
      externalExtension('conflict', () => [
        {
          lane: 'provider',
          clientId: CLAUDE_CLIENT_ID,
          contractId: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
          id: 'allow',
          priority: 200,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => ({ providerEnvelope: createApproveEffect('allow first') }),
        },
        {
          lane: 'provider',
          clientId: CLAUDE_CLIENT_ID,
          contractId: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
          id: 'deny',
          priority: 100,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => ({ providerEnvelope: createDenyEffect('deny wins') }),
        },
      ]),
      externalExtension('invalid-batch', () => [
        {
          lane: 'canonical',
          id: 'valid-but-rolled-back',
          priority: 100,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => undefined,
        },
        {
          lane: 'canonical',
          id: 'valid-but-rolled-back',
          priority: 100,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => undefined,
        },
      ]),
    ]);
    try {
      expect(snapshot(runtime.coordinator).map((entry) => entry.namespacedId)).toEqual([
        'conflict/allow',
        'conflict/deny',
      ]);
      const result = await runtime.bus.request(ClaudeCodeClientSubjects.hook.handle, hookRequest());
      expect(responseOutput(result.stdout).permissionDecision).toBe('deny');
    } finally {
      await runtime.coordinator.shutdown();
    }
  });

  it('applies open failures, timeout failures, and closed failures at the request boundary', async () => {
    const runtime = await startRuntime([
      externalExtension('open-and-timeout', () => [
        {
          lane: 'canonical',
          id: 'survives',
          priority: 300,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => ({ canonicalEffects: [createAppendEffect('survives')] }),
        },
        {
          lane: 'canonical',
          id: 'throws-open',
          priority: 200,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => {
            throw new Error('open failure');
          },
        },
        {
          lane: 'canonical',
          id: 'times-out-open',
          priority: 100,
          timeoutMs: 1,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: async () => new Promise(() => undefined),
        },
      ]),
    ]);
    try {
      const openResult = await runtime.bus.request(ClaudeCodeClientSubjects.hook.handle, hookRequest());
      expect(responseOutput(openResult.stdout).additionalContext).toBe('survives');
    } finally {
      await runtime.coordinator.shutdown();
    }

    const closedRuntime = await startRuntime([
      externalExtension('closed', () => [
        {
          lane: 'provider',
          clientId: CLAUDE_CLIENT_ID,
          contractId: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
          id: 'closed',
          priority: 100,
          timeoutMs: 500,
          failurePolicy: 'closed',
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => {
            throw new Error('closed failure');
          },
        },
      ]),
    ]);
    try {
      const closedResult = await closedRuntime.bus.request(ClaudeCodeClientSubjects.hook.handle, hookRequest());
      expect(responseOutput(closedResult.stdout).permissionDecision).toBe('deny');
    } finally {
      await closedRuntime.coordinator.shutdown();
    }
  });

  it('removes and recreates contributors on disable, re-enable, and coordinator shutdown', async () => {
    let activations = 0;
    const extension = externalExtension('lifecycle', () => {
      activations += 1;
      return [
        {
          lane: 'canonical',
          id: 'fresh',
          priority: 100,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: () => ({ canonicalEffects: [createAppendEffect(`activation-${String(activations)}`)] }),
        },
      ];
    });
    const runtime = await startRuntime([extension]);
    const registry = runtime.coordinator.getExtensionService(ClientsCoreToken)!.hookResponseRegistry;
    try {
      expect(snapshot(runtime.coordinator)).toHaveLength(1);
      await runtime.coordinator.handleSetEnabled('lifecycle', false);
      expect(snapshot(runtime.coordinator)).toHaveLength(0);
      await runtime.coordinator.handleSetEnabled('lifecycle', true);
      expect(snapshot(runtime.coordinator)).toHaveLength(1);
      expect(activations).toBe(2);
    } finally {
      await runtime.coordinator.shutdown();
    }
    expect(
      registry.snapshot(CLAUDE_CLIENT_ID, CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID, 'PreToolUse', ['context.append']),
    ).toHaveLength(0);
  });

  it('preserves registration order under concurrent contributors and forwards hook correlation', async () => {
    let captured: unknown;
    let started = 0;
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitForSibling = async () => {
      started += 1;
      if (started === 2) release?.();
      await bothStarted;
    };
    const runtime = await startRuntime([
      externalExtension('concurrent', () => [
        {
          lane: 'canonical',
          id: 'first',
          priority: 100,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: async (ctx) => {
            captured = ctx.eventPayload;
            await waitForSibling();
            return { canonicalEffects: [createAppendEffect('first')] };
          },
        },
        {
          lane: 'canonical',
          id: 'second',
          priority: 100,
          timeoutMs: 500,
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
          respond: async () => {
            await waitForSibling();
            return { canonicalEffects: [createAppendEffect('second')] };
          },
        },
      ]),
    ]);
    try {
      const result = await runtime.bus.request(ClaudeCodeClientSubjects.hook.handle, hookRequest('read_file'));
      expect(started).toBe(2);
      expect(responseOutput(result.stdout).additionalContext).toBe('first\nsecond');
      expect(captured).toMatchObject({ session_id: 'session-42', tool_name: 'read_file', tool_use_id: 'tool-99' });
    } finally {
      await runtime.coordinator.shutdown();
    }
  });

  it('contributor factory captures bus from extensionContext and uses it at callback time', async () => {
    const extension: KernelMakaioExtension = {
      name: 'ctx-consumer',
      displayName: 'Context Consumer',
      version: '0.1.0',
      dependencies: [dep('claude-code.runtime')],
      clientHookResponses: {
        createContributors: (ctx) => {
          // Capture the bus from the extension context at activation time.
          const bus = ctx.extensionContext.bus;
          return [
            {
              lane: 'canonical' as const,
              id: 'bus-enricher',
              priority: 100,
              timeoutMs: 500,
              selectors: [{ kind: 'event-name' as const, name: 'PreToolUse' }],
              respond: async () => {
                // Use the captured bus at callback time to prove it's live.
                const hasBus = typeof bus.emit === 'function';
                return {
                  canonicalEffects: [createAppendEffect(hasBus ? 'bus-alive' : 'bus-missing')],
                };
              },
            },
          ];
        },
      },
    };

    const runtime = await startRuntime([extension]);
    try {
      const result = await runtime.bus.request(ClaudeCodeClientSubjects.hook.handle, hookRequest());
      expect(responseOutput(result.stdout).additionalContext).toBe('bus-alive');
    } finally {
      await runtime.coordinator.shutdown();
    }
  });
});

/**
 * Native capability honesty tests.
 *
 * Verifies that:
 * - Fork directive fields are carried through the agent creation pipeline
 * - The ConformanceTestConfig type exposes nativeResume and nativeFork flags
 * - AgentCreationOptions includes the nativeFork field
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  type NativeForkDirective,
  type ProviderContext,
  type SessionContext,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import type { ConformanceTestConfig } from '../../types/conformance-test-config.js';
import type { AgentCreationOptions } from '../types.js';
import { buildNativeForkDirective } from '../ai-adapter-create-utils.js';
import { createTestAdapter, type ConfigFactoryInput, type TestBus } from './shared.js';
import os from 'node:os';

const approvedNativeFork: NativeForkDirective = {
  sourceSessionId: 'approved-source-session',
  sourceAdapterSessionId: 'approved-source-adapter-session',
  forkPointMessageId: 'approved-message-checkpoint',
  targetWorkingDirectory: '/approved-workspace',
};

const NO_AUTH_PROVIDER_CONTEXT = {
  state: 'resolved',
  providerConfigId: 'provider-config',
  definitionId: 'provider',
  auth: {
    mode: 'none',
    method: { owner: 'provider', providerDefinitionId: 'provider', methodId: 'none' },
    definition: { id: 'none', mode: 'none', label: 'No authentication' },
  },
} satisfies ProviderContext;

/**
 * Build a fork-mode request with raw fork fields that intentionally differ from
 * the orchestrator-approved `sessionContext.nativeFork`.
 * @param sessionContext - Optional session context attached to the creation request
 * @returns Agent creation request carrying fork-mode raw fields
 */
function createRawForkRequest(
  sessionContext?: SessionContext,
): AgentCreationOptions & { sessionContext?: SessionContext } {
  return {
    mode: 'fork',
    sourceSessionId: 'raw-source-session',
    sourceAdapterSessionId: 'raw-source-adapter-session',
    forkPointMessageId: 'raw-message-checkpoint',
    targetWorkingDirectory: '/raw-workspace',
    ...(sessionContext !== undefined && { sessionContext }),
  };
}

describe('AgentCreationOptions carries fork directive fields', () => {
  it('includes nativeFork field in AgentCreationOptions type', () => {
    // This is a type-level test: verify that nativeFork is assignable to AgentCreationOptions.
    // If the type is missing the field, TypeScript will error at compile time.
    const options: AgentCreationOptions = {
      nativeFork: {
        sourceSessionId: 'session-source',
        sourceAdapterSessionId: 'adapter-source',
        forkPointMessageId: 'msg-1',
        targetWorkingDirectory: '/workspace',
      },
    };
    expect(options.nativeFork).toBeDefined();
    expect(options.nativeFork?.sourceSessionId).toBe('session-source');
    expect(options.nativeFork?.sourceAdapterSessionId).toBe('adapter-source');
    expect(options.nativeFork?.forkPointMessageId).toBe('msg-1');
    expect(options.nativeFork?.targetWorkingDirectory).toBe('/workspace');
  });

  it('allows nativeFork to be undefined', () => {
    const options: AgentCreationOptions = { model: 'test-model' };
    expect(options.nativeFork).toBeUndefined();
  });

  it('allows nativeFork without optional fields', () => {
    const options: AgentCreationOptions = {
      nativeFork: {
        sourceSessionId: 'session-source',
        sourceAdapterSessionId: 'adapter-source',
      },
    };
    expect(options.nativeFork?.forkPointMessageId).toBeUndefined();
    expect(options.nativeFork?.targetWorkingDirectory).toBeUndefined();
  });
});

describe('ConformanceTestConfig capability flags include nativeResume and nativeFork', () => {
  it('accepts nativeResume flag on capabilities', () => {
    // Type-level test: verify that nativeResume is a valid ConformanceTestConfig capability flag.
    const config: Pick<ConformanceTestConfig, 'capabilities'> = {
      capabilities: {
        nativeResume: true,
      },
    };
    expect(config.capabilities?.nativeResume).toBe(true);
  });

  it('accepts nativeFork flag on capabilities', () => {
    const config: Pick<ConformanceTestConfig, 'capabilities'> = {
      capabilities: {
        nativeFork: true,
      },
    };
    expect(config.capabilities?.nativeFork).toBe(true);
  });

  it('allows both flags to be omitted (defaults to undefined)', () => {
    const config: Pick<ConformanceTestConfig, 'capabilities'> = {
      capabilities: {},
    };
    expect(config.capabilities?.nativeResume).toBeUndefined();
    expect(config.capabilities?.nativeFork).toBeUndefined();
  });

  it('allows all three flags together', () => {
    const config: Pick<ConformanceTestConfig, 'capabilities'> = {
      capabilities: {
        supportsUsageMetrics: true,
        nativeResume: true,
        nativeFork: true,
      },
    };
    expect(config.capabilities?.supportsUsageMetrics).toBe(true);
    expect(config.capabilities?.nativeResume).toBe(true);
    expect(config.capabilities?.nativeFork).toBe(true);
  });
});

describe('buildNativeForkDirective', () => {
  it('does not assemble a provider-native fork from raw fork-mode fields without native sessionContext', () => {
    expect(buildNativeForkDirective(createRawForkRequest())).toBeUndefined();
  });

  it.each([
    { name: 'degraded locality', nativeLocality: { kind: 'degrade' as const, reason: 'cwd-mismatch' as const } },
    { name: 'foreign locality', nativeLocality: { kind: 'foreign' as const, machineId: 'remote-machine' } },
  ])('ignores raw fork-mode fields for $name', ({ nativeLocality }) => {
    expect(
      buildNativeForkDirective(
        createRawForkRequest({
          nativeLocality,
          nativeFork: approvedNativeFork,
        }),
      ),
    ).toBeUndefined();
  });

  it('uses the orchestrator-approved nativeFork from native sessionContext', () => {
    expect(
      buildNativeForkDirective(
        createRawForkRequest({
          nativeLocality: { kind: 'native' },
          nativeFork: approvedNativeFork,
        }),
      ),
    ).toEqual(approvedNativeFork);
  });

  it('ignores nativeFork context for non-fork creation requests', () => {
    const request: AgentCreationOptions & { sessionContext: SessionContext } = {
      mode: 'create',
      sessionContext: {
        nativeLocality: { kind: 'native' },
        nativeFork: approvedNativeFork,
      },
    };

    expect(buildNativeForkDirective(request)).toBeUndefined();
  });
});

describe('AIAdapter.createAgent forwards fork directive from startAgent fork mode', () => {
  let adapter: ReturnType<typeof createTestAdapter>['adapter'];
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await adapter?.closeAsync();
  });

  it('passes orchestrator-approved nativeFork directive to the config factory when sessionContext is native', async () => {
    const capturedInputs: Array<ConfigFactoryInput<TestBus> & { nativeFork?: NativeForkDirective }> = [];

    ({ adapter } = createTestAdapter('test-adapter-fork-directive', {
      configFactory: async (input) => {
        capturedInputs.push(input);
        return {
          bus: input.bus,
          agentId: input.agentId,
          adapterId: input.adapterId,
          adapterName: input.adapterName,
          model: input.model ?? 'test-model',
          cwd: input.cwd ?? os.tmpdir(),
        };
      },
      connectorFactory: async (config) => {
        const { MockConnector } = await import('./shared.js');
        return new MockConnector(config);
      },
    }));
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const forkResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'fork',
      sessionId: 'fork-session',
      sourceSessionId: 'source-session',
      sourceAdapterSessionId: 'source-adapter-session',
      forkPointMessageId: 'message-checkpoint',
      targetWorkingDirectory: '/workspace',
      sessionContext: {
        nativeLocality: { kind: 'native' },
        nativeFork: approvedNativeFork,
      },
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: NO_AUTH_PROVIDER_CONTEXT,
    });

    expect(forkResult.success).toBe(true);
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].nativeFork).toEqual(approvedNativeFork);
  });
});

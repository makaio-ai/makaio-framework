import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { ClientAccountRegistry } from '../client-account-registry.js';
import { ClientRuntimeRegistry } from '../client-runtime-registry.js';
import { ClientRuntimeService } from '../client-runtime-service.js';

describe('ClientRuntimeService — runtime.resolveBySupervisorSessionId', () => {
  let bus: IMakaioBus;
  let registry: ClientRuntimeRegistry;
  let service: ClientRuntimeService;

  beforeEach(async () => {
    bus = createBusInstance();
    registry = new ClientRuntimeRegistry(bus);
    service = new ClientRuntimeService(bus, new ClientAccountRegistry(), registry);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('reads a narrow, detached correlation for a known supervisor session without changing the registry', async () => {
    const supervisorSessionId = 'sup-codex-runtime-1';
    const beforeKnown = await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
      clientId: 'codex',
      supervisorSessionId,
    });

    expect(beforeKnown).toEqual({ runtime: null });
    expect(registry.size).toBe(0);

    const launched = await bus.request(ClientSubjects.runtime.observe, {
      clientId: 'codex',
      source: { layer: 'supervisor', producer: 'test-supervisor' },
      observedAt: 1_700_000_000_000,
      supervisorSessionId,
      pid: 4401,
      cwd: '/workspace/private-project',
      argv: ['codex', '--dangerously-bypass-approvals-and-sandbox'],
      metadata: { private: 'do-not-return' },
    });
    await bus.request(ClientSubjects.runtime.observe, {
      clientId: 'codex',
      source: { layer: 'adapter', producer: 'test-codex-adapter' },
      observedAt: 1_700_000_001_000,
      supervisorSessionId,
      pid: 4401,
      adapterSessionId: 'native-codex-session-1',
      sessionId: 'framework-session-1',
    });
    const recordBeforeRead = registry.getRuntime(launched.clientRuntimeId);

    const resolved = await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
      clientId: 'codex',
      supervisorSessionId,
    });

    expect(resolved).toEqual({
      runtime: {
        clientId: 'codex',
        supervisorSessionId,
        adapterSessionId: 'native-codex-session-1',
        sessionId: 'framework-session-1',
      },
    });
    expect(registry.size).toBe(1);
    expect(registry.getRuntime(launched.clientRuntimeId)).toEqual(recordBeforeRead);

    expect(
      await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
        clientId: 'claude-code',
        supervisorSessionId,
      }),
    ).toEqual({ runtime: null });
    expect(
      await bus.request(ClientSubjects.runtime.resolveBySupervisorSessionId, {
        clientId: 'codex',
        supervisorSessionId: 'sup-codex-runtime-other',
      }),
    ).toEqual({ runtime: null });

    if (resolved.runtime !== null) {
      resolved.runtime.adapterSessionId = 'mutated-by-caller';
    }
    expect(registry.getRuntime(launched.clientRuntimeId)?.adapterSessionId).toBe('native-codex-session-1');
  });
});

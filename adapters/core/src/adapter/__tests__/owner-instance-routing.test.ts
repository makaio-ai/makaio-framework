import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusContext, createBusInstance, MakaioBus } from '@makaio/bus-core';
import { AdapterNamespace, AdapterSubjects } from '@makaio/contracts';
import { createBidirectionalTransportPair } from '../../../../../core/bus-core/src/__tests__/helpers/transport-fixtures.js';
import type { TestAdapter } from './shared.js';
import { createTestAdapter } from './shared.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

const ADAPTER_ID = 'shared-deterministic-adapter-id';
const NON_OWNER_INSTANCE_ID = 'runtime-non-owner';
const OWNER_INSTANCE_ID = 'runtime-exact-owner';

describe('AIAdapter owner-instance routing', () => {
  const adapters: TestAdapter[] = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.closeAsync()));
    MakaioBus.__resetHandlers?.();
  });

  it('lets only the exact runtime owner answer targeted stop requests', async () => {
    const nonOwner = createTestAdapter('shared-adapter', {
      adapterId: ADAPTER_ID,
      ownerInstanceId: NON_OWNER_INSTANCE_ID,
    }).adapter;
    const owner = createTestAdapter('shared-adapter', {
      adapterId: ADAPTER_ID,
      ownerInstanceId: OWNER_INSTANCE_ID,
    }).adapter;
    adapters.push(nonOwner, owner);

    // Registration order is load-bearing: dispatch sees the non-owner first.
    await nonOwner.init();
    await owner.init();

    const started = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: ADAPTER_ID,
      ownerInstanceId: OWNER_INSTANCE_ID,
      agentId: 'owner-routed-agent',
      sessionId: 'owner-routed-session',
      role: 'lead',
      providerContext: createNoAuthTestProviderContext('routing-config', 'routing-provider'),
    });
    expect(started).toMatchObject({
      success: true,
      ownerInstanceId: OWNER_INSTANCE_ID,
      agentId: 'owner-routed-agent',
    });

    await expect(
      MakaioBus.request(AdapterSubjects.stopAgent, {
        adapterId: ADAPTER_ID,
        ownerInstanceId: OWNER_INSTANCE_ID,
        agentId: 'owner-routed-agent',
      }),
    ).resolves.toMatchObject({ success: true });

    await expect(
      MakaioBus.request(AdapterSubjects.stopAgent, {
        adapterId: ADAPTER_ID,
        ownerInstanceId: OWNER_INSTANCE_ID,
        agentId: 'already-absent-agent',
      }),
    ).resolves.toEqual({ success: false, evidence: 'released' });
  });

  it('lets only the exact runtime owner answer targeted liveness probes', async () => {
    const nonOwner = createTestAdapter('shared-adapter', {
      adapterId: ADAPTER_ID,
      ownerInstanceId: NON_OWNER_INSTANCE_ID,
    }).adapter;
    const owner = createTestAdapter('shared-adapter', {
      adapterId: ADAPTER_ID,
      ownerInstanceId: OWNER_INSTANCE_ID,
    }).adapter;
    adapters.push(nonOwner, owner);

    // Registration order is load-bearing: dispatch sees the non-owner first.
    await nonOwner.init();
    await owner.init();

    await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: ADAPTER_ID,
      ownerInstanceId: OWNER_INSTANCE_ID,
      agentId: 'owner-probed-agent',
      sessionId: 'owner-probed-session',
      role: 'lead',
      providerContext: createNoAuthTestProviderContext('routing-config', 'routing-provider'),
    });
    await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: ADAPTER_ID,
      ownerInstanceId: NON_OWNER_INSTANCE_ID,
      agentId: 'hosted-by-non-owner',
      sessionId: 'non-owner-session',
      role: 'lead',
      providerContext: createNoAuthTestProviderContext('routing-config', 'routing-provider'),
    });

    await expect(
      MakaioBus.request(AdapterSubjects.getAgent, {
        adapterId: ADAPTER_ID,
        ownerInstanceId: OWNER_INSTANCE_ID,
        agentId: 'owner-probed-agent',
      }),
    ).resolves.toMatchObject({ agent: { agentId: 'owner-probed-agent' } });

    await expect(
      MakaioBus.request(AdapterSubjects.getAgent, {
        adapterId: ADAPTER_ID,
        ownerInstanceId: OWNER_INSTANCE_ID,
        agentId: 'hosted-by-non-owner',
      }),
    ).resolves.toEqual({ agent: null });
  });

  it('routes exact-owner liveness and teardown through a hub past a non-owner peer', async () => {
    const hubBus = createBusInstance({ context: createBusContext() });
    const nonOwnerBus = createBusInstance({ context: createBusContext() });
    const ownerBus = createBusInstance({ context: createBusContext() });
    for (const bus of [hubBus, nonOwnerBus, ownerBus]) bus.registerNamespace(AdapterNamespace);

    const nonOwner = createTestAdapter('shared-adapter', {
      adapterId: ADAPTER_ID,
      ownerInstanceId: NON_OWNER_INSTANCE_ID,
      globalBus: nonOwnerBus,
    }).adapter;
    const owner = createTestAdapter('shared-adapter', {
      adapterId: ADAPTER_ID,
      ownerInstanceId: OWNER_INSTANCE_ID,
      globalBus: ownerBus,
    }).adapter;
    adapters.push(nonOwner, owner);

    const nonOwnerLink = createBidirectionalTransportPair({
      label: 'owner-routing-hub-non-owner',
    });
    const ownerLink = createBidirectionalTransportPair({
      label: 'owner-routing-hub-owner',
    });
    hubBus.registerTransport(nonOwnerLink.sideA);
    nonOwnerBus.registerTransport(nonOwnerLink.sideB);
    hubBus.registerTransport(ownerLink.sideA);
    ownerBus.registerTransport(ownerLink.sideB);

    try {
      await nonOwner.init();
      await owner.init();
      for (const subject of ['adapter.getAgent', 'adapter.stopAgent']) {
        hubBus.getContext().remoteRequestHandlers.set(subject, [
          { transport: nonOwnerLink.sideA.name, priority: 0 },
          { transport: ownerLink.sideA.name, priority: 0 },
        ]);
      }

      const started = await ownerBus.request(AdapterSubjects.startAgent, {
        adapterId: ADAPTER_ID,
        ownerInstanceId: OWNER_INSTANCE_ID,
        agentId: 'hub-owned-agent',
        sessionId: 'hub-owned-session',
        role: 'lead',
        providerContext: createNoAuthTestProviderContext('routing-config', 'routing-provider'),
      });
      if (!started.success) throw new Error('owner adapter did not start the hub routing agent');

      await expect(
        hubBus.request(AdapterSubjects.getAgent, {
          adapterId: ADAPTER_ID,
          ownerInstanceId: OWNER_INSTANCE_ID,
          agentId: started.agentId,
        }),
      ).resolves.toMatchObject({ agent: { agentId: started.agentId } });
      await expect(
        hubBus.request(AdapterSubjects.stopAgent, {
          adapterId: ADAPTER_ID,
          ownerInstanceId: OWNER_INSTANCE_ID,
          agentId: started.agentId,
        }),
      ).resolves.toMatchObject({ success: true });
    } finally {
      hubBus.disconnect();
      nonOwnerBus.disconnect();
      ownerBus.disconnect();
    }
  });
});

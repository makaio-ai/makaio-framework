import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { createMessagePortTransport } from '@makaio/bus-transport-message-channel';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts/extension';
import {
  ClientSubjects,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  SessionSubjects,
} from '@makaio/contracts';
import { ExtensionCoordinator, ExtensionStorageCapabilityError, type KernelMakaioExtension } from '@makaio/kernel';
import { FileAdapterConfigRepository } from '@makaio/subsystem-adapter';
import { SessionStorageToken, sessionStoragePackage } from '@makaio/services-core';
import { SessionStorageSubjects } from '@makaio/services-core/session/storage/namespace';
import { ClientRuntimeStorageSubjects, clientStoragePackage } from '@makaio/subsystem-client';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  describeStorageConformance,
  makeSession,
  useJournalHostFixture,
  useSuiteDatabaseContext,
} from '../../../../../storage/conformance/src/index.js';
import type { ShutdownStep } from '../../boot-phase.js';
import { createIsolatedWorkflowRuntime } from '../isolated-workflow-runtime.js';
import { createReverseShutdownRunner } from '../reverse-shutdown-runner.js';

const context = {
  cwd: tmpdir(),
  platform: process.platform,
  homedir: tmpdir(),
  makaioHome: tmpdir(),
  username: 'workflow-worker',
  machineId: 'isolated-storage-worker',
};

describeStorageConformance('isolated workflow storage', (config) => {
  const { getDatabase, constructContext } = useJournalHostFixture(useSuiteDatabaseContext(config));
  const configRepository = new FileAdapterConfigRepository({
    adaptersDir: join(context.makaioHome, 'isolated-storage-worker-adapters'),
    providerConfigsDir: join(context.makaioHome, 'isolated-storage-worker-providers'),
  });

  it('rejects database contributions before reading their client definitions', async () => {
    const readClients = vi.fn(() => []);
    const databaseExtension: KernelMakaioExtension<IsolatedNodeExtensionContext<IMakaioBus>> = {
      name: 'database-contribution',
      displayName: 'Database Contribution',
      version: '1.0.0',
      storage: { migrations: './drizzle' },
      get clients() {
        return readClients();
      },
    };
    await expect(
      createIsolatedWorkflowRuntime({
        connectAuthority: async () => {},
        configRepository,
        contributedPackages: [databaseExtension],
        context,
        toolsets: [],
      }),
    ).rejects.toBeInstanceOf(ExtensionStorageCapabilityError);
    expect(readClients).not.toHaveBeenCalled();
  });

  it('uses authority storage without local database packages', async () => {
    const database = getDatabase();
    const cleanup: ShutdownStep[] = [];
    onTestFinished(createReverseShutdownRunner(cleanup));
    const authority = createBusInstance();
    cleanup.push(() => authority.disconnect());
    authority.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
    const coordinator = new ExtensionCoordinator(authority, {
      extensionContextBase: { ...context, tryImport: async () => null, constructContext },
      db: database.db,
      runtimeEnvironment: { hosts: new Set(['node']), capabilities: new Set(['storage.drizzle']) },
    });
    cleanup.push(() => coordinator.shutdown());
    const { port1, port2 } = new MessageChannel();
    cleanup.push(
      () => port1.close(),
      () => port2.close(),
    );
    const session = makeSession();
    const correlation = { clientId: 'test-client', supervisorSessionId: 'test-supervisor-session' };
    coordinator.load([sessionStoragePackage, clientStoragePackage]);
    await coordinator.startAll();
    // ORIGIN: The authority seeds its durable session and client runtime fixtures.
    const seed = authority.own('start');
    await authority.request(seed, SessionStorageSubjects.set, { sessionId: session.sessionId, session });
    const now = Date.now();
    await authority.request(seed, ClientRuntimeStorageSubjects.upsert, {
      ...correlation,
      clientRuntimeId: 'runtime-from-authority',
      status: 'started',
      observedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    authority.registerTransport(createMessagePortTransport({ port: port1 }));
    const authorityConnected = authority.connect();
    const runtime = await createIsolatedWorkflowRuntime({
      connectAuthority: async (bus) => {
        bus.registerTransport(createMessagePortTransport({ port: port2 }));
        await Promise.all([authorityConnected, bus.connect()]);
      },
      configRepository,
      contributedPackages: [],
      context,
      toolsets: [],
    });
    cleanup.push(runtime.shutdown);
    expect(runtime.coordinator.getInfo(SessionStorageToken.name)).toBeNull();
    expect(runtime.coordinator.getInfo(clientStoragePackage.name)).toBeNull();
    // ORIGIN: An isolated runtime caller reads its authority's durable fixtures.
    const read = runtime.bus.own('start');
    await expect(
      runtime.bus.request(read, SessionSubjects.get, { sessionId: session.sessionId }),
    ).resolves.toMatchObject({
      session: { sessionId: session.sessionId },
    });
    await expect(
      runtime.bus.request(read, ClientSubjects.runtime.resolveBySupervisorSessionId, correlation),
    ).resolves.toEqual({
      runtime: { ...correlation, updatedAt: now },
    });
  });
});

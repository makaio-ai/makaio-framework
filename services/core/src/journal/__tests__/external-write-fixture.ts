import { createServer } from 'node:http';
import { createBusInstance } from '@makaio/bus-core';
import { createSecret } from '@makaio/contracts';
import {
  ExternalObjectRefSchema,
  JournalNamespace,
  type ExternalObjectRef,
  type FindExistingInput,
  type WriterInput,
  type WriterOutcome,
  type WriteParticipantContribution,
  type WriteRequest,
  type WritesCapability,
} from '@makaio/contracts/journal';
import type { CallContext, CallContextRecord } from '@makaio/core';
import { createCoordinatorRights, ExtensionCoordinator, type KernelExtensionContext } from '@makaio/kernel';
import { SUBJECT_SEND_RIGHT } from '@makaio/contracts/rights';
import { type StorageDatabaseContext, useJournalHostFixture } from '@makaio/storage-conformance';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { onTestFinished } from 'vitest';
import { createWriteJournal } from '../index.js';

export const connector = 'example-connector';
export const writer = `${connector}.writer`;
export const participantName = 'example-writes.binding';
export const parent = { extension: connector, site: 'example', objectType: 'collection', externalId: 'parent' };

interface ConnectorOptions {
  readonly lookup?: 'undecidable' | 'contradictory';
  readonly object?: ExternalObjectRef;
  readonly beforeMutation?: (input: WriterInput) => Promise<WriterOutcome | void>;
  readonly afterMutation?: (input: WriterInput) => Promise<void>;
  readonly afterLookup?: (input: FindExistingInput) => Promise<void>;
}

/**
 * Serve durable external effects outside the journal host's lifetime.
 * @param options - Behaviour of the writer's lookup and optional fixed object identity.
 * @returns Registered writer and observable endpoint state.
 */
export async function useExternalEndpoint(options: ConnectorOptions = {}) {
  const objects = new Map<string, ExternalObjectRef>();
  let writes = 0;
  let mutations = 0;
  let lookups = 0;
  const server = createServer((request, response) => {
    const intentId = request.url?.slice(1) ?? '';
    if (request.method === 'PUT') {
      mutations += 1;
      const object = options.object ?? { ...parent, objectType: 'child', externalId: intentId, parent };
      objects.set(intentId, object);
    }
    const object = objects.get(intentId);
    response.writeHead(object ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(object ?? null));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP endpoint.');
  const url = `http://127.0.0.1:${address.port}`;

  /**
   * Read or mutate the external object, keyed by the durable intent.
   * @param intentId - Stored intent identity.
   * @param method - HTTP method.
   * @returns The external object if present.
   */
  async function request(intentId: string, method: 'GET' | 'PUT'): Promise<ExternalObjectRef | undefined> {
    const response = await fetch(`${url}/${intentId}`, { method });
    if (response.status === 404) return undefined;
    return ExternalObjectRefSchema.parse(await response.json());
  }

  return {
    contribution: {
      writer,
      description: 'Write to the local test endpoint.',
      contentSchema: { type: 'string' },
      objectTypes: ['child'],
      /**
       * @param input - Durable write intent.
       * @returns Confirmed external object.
       */
      async write(input) {
        writes += 1;
        const result = await options.beforeMutation?.(input);
        if (result) return result;
        const object = await request(input.intentId, 'PUT');
        if (!object) throw new Error('External mutation was not observed.');
        await options.afterMutation?.(input);
        return { written: object };
      },
      /**
       * @param input - Durable write intent.
       * @returns Lookup result read from the endpoint.
       */
      async findExisting(input) {
        lookups += 1;
        const object = await request(input.intentId, 'GET');
        await options.afterLookup?.(input);
        if (options.lookup === 'undecidable') return { undecidable: 'Lookup unsupported' };
        if (object) return { found: object };
        const absent = { absent: true } as const;
        if (options.lookup === 'contradictory') Reflect.set(absent, 'undecidable', 'Lookup disagrees with itself');
        return absent;
      },
    } satisfies import('@makaio/contracts/journal').WriterContribution,
    /** Number of calls to the external writer. */
    get writes() {
      return writes;
    },
    /** Number of external write requests. */
    get mutations() {
      return mutations;
    },
    /** Number of calls to the writer lookup. */
    get lookups() {
      return lookups;
    },
  };
}

interface StartOptions {
  readonly participant?: WriteParticipantContribution;
  readonly authorize?: (call: CallContextRecord) => boolean;
  readonly deadline?: () => number;
  readonly beforeCredential?: () => Promise<void>;
  readonly database?: StorageDatabaseContext['db'];
}

interface WriteClient {
  readonly writes: WritesCapability;
  readonly call: CallContext;
}

/**
 * Read the intent stored for a write key.
 * @param client - Extension capability and its call context.
 * @param request - Request identifying the write.
 * @returns Current public record with its persisted intent identifier.
 */
export async function readRecord(client: WriteClient, request: WriteRequest) {
  const { writes } = await client.writes.readWrites(client.call, {
    byKey: { writer: request.writer, key: request.key },
  });
  const [record] = writes;
  if (!record || record.intentId === null) throw new Error('Expected a record with an intent identifier.');
  return { ...record, intentId: record.intentId };
}

/**
 * Set up one migrated database and a reusable host composition fixture for an acceptance suite.
 * @param getDatabase - Suite-local migrated database accessor.
 * @returns A function starting a host over that database.
 */
export function useWriteHost(getDatabase: () => Pick<StorageDatabaseContext, 'db'>) {
  const { constructContext } = useJournalHostFixture(getDatabase);

  /**
   * Activate real writer and participant contributions on a fresh coordinator.
   * @param endpoint - Real external endpoint and writer.
   * @param options - Host policy and supplied contribution.
   * @returns Extension capabilities, host database and bus handles.
   */
  return async function start(endpoint: Awaited<ReturnType<typeof useExternalEndpoint>>, options: StartOptions = {}) {
    const bus = createBusInstance();
    bus.registerNamespace(JournalNamespace);
    const host = createHostDatabase(options.database ?? getDatabase().db);
    const rights = createCoordinatorRights(bus, 'host');
    const right = 'example-writes.perform';
    const setup = createWriteJournal(host, bus, rights.hostRights, {
      authorizeWrite: async (call, context) => (await rights.hostRights.resolve({ call, right, context })).granted,
      deadline: options.deadline ?? (() => Date.now() + 30_000),
    });
    let client: WriteClient | undefined;
    let denied: WriteClient | undefined;
    const owner = 'example-writes';
    const coordinator = new ExtensionCoordinator<KernelExtensionContext>(bus, {
      rights,
      extensionContextBase: {
        platform: 'linux',
        homedir: '/home/test',
        makaioHome: '/home/test/.makaio',
        username: 'test',
        machineId: 'write-journal-test',
        tryImport: async () => null,
        /** @param context - Shared context supplied by the coordinator. */
        constructContext(context) {
          const extension = context.identity.extensionName;
          return {
            ...constructContext(context),
            database: host,
            writes: setup.bind(extension, context.bus, () => context.hasExtension(extension)),
          };
        },
      },
    });
    coordinator.registerContributionProcessor(setup.contributions);
    coordinator.load([
      {
        name: connector,
        displayName: connector,
        version: '1.0.0',
        critical: true,
        writers: [endpoint.contribution],
        credentialResolver: {
          resolve: async (_call, request) => {
            await options.beforeCredential?.();
            if (request.requester !== connector || request.purpose !== 'example.write') {
              return { success: false, error: { code: 'refused', message: 'Refused' } };
            }
            return { success: true, value: createSecret(crypto.randomUUID()) };
          },
        },
      },
      {
        name: owner,
        displayName: owner,
        version: '1.0.0',
        critical: true,
        writeParticipants: options.participant ? [options.participant] : [],
        rights: [{ right, description: 'Perform a journal write.', context: { type: 'object' } }],
        rightsSources: options.authorize
          ? [
              {
                source: 'example-writes.access',
                description: 'Decide who can use journal operations.',
                rights: [right, SUBJECT_SEND_RIGHT],
                answer: async ({ call }) =>
                  options.authorize?.(call) ? { granted: true } : { granted: false, reason: 'denied-by-policy' },
              },
            ]
          : [],
        create: ({ writes, bus: carrier }) => {
          if (!writes) throw new Error('Expected the write capability.');
          client = { writes, call: carrier.own('root') };
          return {};
        },
      },
      {
        name: 'denied',
        displayName: 'Denied',
        version: '1.0.0',
        critical: true,
        create: ({ writes, bus: carrier }) => {
          if (!writes) throw new Error('Expected the write capability.');
          denied = { writes, call: carrier.own('root') };
          return {};
        },
      },
    ]);
    /** Stop the host, retaining the test database and endpoint. */
    async function close(): Promise<void> {
      setup.destroy();
      await coordinator.shutdown();
    }
    onTestFinished(close);
    await coordinator.startAll();
    if (!client || !denied) throw new Error('Expected both extension capabilities.');
    return { client, denied, bus, host, close };
  };
}

/**
 * Build a unique write request for the endpoint.
 * @param overrides - Fields varied by the scenario.
 * @returns Request with a unique key.
 */
export function writeRequest(overrides: Partial<WriteRequest> = {}): WriteRequest {
  return {
    key: crypto.randomUUID(),
    writer,
    target: { create: { site: parent.site, objectType: 'child', parent } },
    content: 'body',
    credential: { purpose: 'example.write' },
    ...overrides,
  };
}

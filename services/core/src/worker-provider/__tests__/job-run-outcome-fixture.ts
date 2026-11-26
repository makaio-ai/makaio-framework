import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createBusInstance, NO_BOUNDARY_ACCESS_CHECK } from '@makaio/bus-core';
import {
  HmacAuth,
  registerHmacIdentitySecret,
  resolveHmacIdentityParty,
  resolveHmacIdentitySecret,
  ServerTransport,
  WebSocketClientTransport,
} from '@makaio/bus-transport-websocket';
import type { HostDatabase, HostTransaction, JsonValue } from '@makaio/contracts';
import {
  JobRunOutcomeNamespace,
  type JobRunAcceptance,
  type JobRunCapability,
  type JobRunOwnerDecision,
  type JobRunResult,
} from '@makaio/contracts/workflow';
import { CorePartyKind, getFullSubjectForSubjectDefinition, type CallContext } from '@makaio/core';
import { ExtensionCoordinator, type ExtensionContextBase } from '@makaio/kernel';
import type { StorageDatabaseContext } from '@makaio/storage-conformance';
import { onTestFinished } from 'vitest';
import { WebSocketServer } from 'ws';
import { JobRunCloseError } from '../job-run-close.js';
import { createJobRunOutcomeReceiver } from '../job-run-outcome-receiver.js';
import type { StartOrder } from '../start-order.js';
import { fixtureToken, providerId } from './ordered-worker-fixture.js';
import {
  bookRedemptionOwner,
  noteTestOwnerEffect,
  readRedemptionOwnerEndings,
  redemptionJournalOwner,
  redemptionOwnerSource,
  testOutcomeOwnerSource,
} from './redemption-owner-fixture.js';

export const subject = JobRunOutcomeNamespace.subjects.outcome.submit;
export const ownerName = redemptionJournalOwner;
const hostCredential = randomUUID();

export interface TestProof {
  readonly identityId: string;
  readonly secret: string;
}

interface OwnerBehavior {
  readonly deferReceiverRegistration?: boolean;
  readonly redemptionOnly?: boolean;
  readonly answer?: JsonValue;
  readonly keepProof?: boolean;
  readonly owner?: string;
  readonly handle?: (
    submission: JobRunAcceptance,
    commit: (during?: (tx: HostTransaction) => Promise<void>) => Promise<void>,
  ) => Promise<JobRunOwnerDecision>;
}

interface ActivatedOwner {
  readonly close: JobRunCapability['close'];
  readonly call: CallContext;
}

const accepted = { decision: 'accepted' } as const;

/**
 * Start one host receiver on an independent socket boundary and activate a real extension.
 * @param storage - Migrated database and independent read connection.
 * @param database - Transaction facade shared by receiver and owner.
 * @param constructContext - Real host context builder for the extension coordinator.
 * @param behavior - Optional disposition and controlled owner transaction hooks.
 * @returns Running host, owner and peer-connection operations.
 */
export async function startOutcomeHost(
  storage: Pick<StorageDatabaseContext, 'executor'>,
  database: HostDatabase,
  constructContext: ExtensionContextBase['constructContext'],
  behavior: OwnerBehavior = {},
) {
  const name = behavior.owner ?? ownerName;
  const listener = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(listener, 'listening');
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener');
  const transport = new ServerTransport({
    websocket: listener,
    auth: new HmacAuth({
      secret: hostCredential,
      resolveSecret: resolveHmacIdentitySecret,
      resolveParty: resolveHmacIdentityParty,
    }),
    checkBoundaryAccess: NO_BOUNDARY_ACCESS_CHECK,
  });
  const bus = createBusInstance({ transports: [transport] });
  bus.registerNamespace(JobRunOutcomeNamespace);
  const backing = behavior.redemptionOnly
    ? redemptionOwnerSource(storage.executor, fixtureToken)
    : testOutcomeOwnerSource(storage.executor, fixtureToken, bus.own('root'), behavior.keepProof ?? true);
  let reads = 0;
  const source = {
    ...backing,
    lockOrder: (...args: Parameters<typeof backing.lockOrder>) => {
      reads++;
      return backing.lockOrder(...args);
    },
  };
  const receiver = createJobRunOutcomeReceiver({ database, source });
  let detach = behavior.deferReceiverRegistration === true ? undefined : receiver.register(bus);
  const coordinator = new ExtensionCoordinator(bus, {
    extensionContextBase: {
      constructContext: (shared) => ({ ...constructContext(shared), database }),
      platform: 'linux',
      homedir: '/tmp',
      makaioHome: '/tmp',
      username: 'test',
      machineId: 'test',
      tryImport: async () => null,
    },
  });
  const attempts: JobRunAcceptance[] = [];
  const activations: ActivatedOwner[] = [];
  coordinator.registerContributionProcessor(receiver.contributionProcessor);
  coordinator.load([
    {
      name,
      displayName: name,
      version: '1.0.0',
      jobRunOutcomes: {
        createHandler(ctx, jobRuns) {
          activations.push({ close: jobRuns.close, call: ctx.bus.own('start') });
          return async (submission) => {
            attempts.push(submission);
            const { result } = submission;
            const commit = (during?: (tx: HostTransaction) => Promise<void>) =>
              ctx.database.transaction(async (tx) => {
                // Lost contenders observe the common row lock before applying any effect.
                const row = await source.lockOrder(tx, result.jobRunId);
                if (row?.outcome?.stored !== undefined) throw new JobRunCloseError('outcome-already-stored');
                await noteTestOwnerEffect(tx, result.jobRunId);
                await submission.jobRuns.close(submission.call, {
                  tx,
                  jobRunId: result.jobRunId,
                  ending: { kind: 'result', result },
                  answer: behavior.answer ?? { version: 1 },
                });
                await during?.(tx);
              });
            if (behavior.handle !== undefined) return await behavior.handle(submission, commit);
            await commit();
            return accepted;
          };
        },
      },
    },
  ]);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      detach?.();
      try {
        await coordinator.shutdown();
      } finally {
        await bus.disconnect();
      }
    })());
  onTestFinished(stop);
  await coordinator.startAll();
  await bus.connect();
  return {
    bus,
    coordinator,
    source,
    attempts,
    activations,
    port: address.port,
    stop,
    reads: () => reads,
    registerOutcomeReceiver() {
      detach = receiver.register(bus);
    },
    dropConnections() {
      for (const socket of listener.clients) socket.terminate();
    },
  };
}

/**
 * Book a run and use the owner adapter's real conditional redemption update.
 * @param host - Receiver and extension using this source.
 * @param database - Transaction facade on the authoritative row.
 * @param id - Unique booking ID.
 * @param options - Owner and clock settings for this booking.
 * @returns Readback and test-only revocation operations.
 */
export async function bookOutcomeRun(
  host: Awaited<ReturnType<typeof startOutcomeHost>>,
  database: HostDatabase,
  id: string,
  options: { readonly owner?: string; readonly redeemed?: boolean; readonly expiresAt?: number } = {},
) {
  const deadline = new Date(options.expiresAt ?? Date.now() + 60_000).toISOString();
  const order: StartOrder = {
    jobRunId: id,
    workerProviderId: providerId,
    bootstrapDeadlineAt: deadline,
    allocationLifetime: 'provisioner-process-bound',
  };
  const party = { kind: CorePartyKind.extension, id: options.owner ?? ownerName };
  const fixture = await bookRedemptionOwner(database, order, party, fixtureToken, false);
  if (options.redeemed !== false) {
    await database.transaction(async (tx) => {
      const locked = await host.source.lockOrder(tx, id);
      const stored = await locked?.redemption?.accept(tx, {
        runtimeDigest: 'test-identity',
        redeemedAt: new Date().toISOString(),
        requiresPlatformProof: false,
        accepted: {
          party: { kind: CorePartyKind.jobRun, id },
          expiresAt: deadline,
          revocationKey: 'test-key',
          payload: null,
        },
      });
      if (stored === undefined) throw new Error('Test booking could not redeem');
    });
  }
  return {
    ...fixture,
    journal: () => database.transaction((tx) => readRedemptionOwnerEndings(tx, id)),
  };
}

/**
 * Register a fixture-owned proof restricted to the actual outcome subject.
 * @param identityId - Run ID assigned by trusted ingress.
 * @param partyKind - Kind minted by the test server.
 * @returns Proof and its cleanup tied to the test.
 */
export function testProof(identityId: string, partyKind: string = CorePartyKind.jobRun): TestProof {
  const secret = randomUUID();
  onTestFinished(
    registerHmacIdentitySecret(identityId, secret, {
      partyKind,
      attestingRole: 'job-run',
      allowedMessageSubjects: [getFullSubjectForSubjectDefinition(subject)],
    }),
  );
  return { identityId, secret };
}

/**
 * Connect an independently authenticated worker bus to the given host.
 * @param port - Loopback listener port.
 * @param proof - Fixture's run identity credential.
 * @param registerContract - Enable client-side validation of requests and replies.
 * @returns Direct request and connection operations.
 */
export async function connectOutcomeWorker(port: number, proof: TestProof, registerContract = true) {
  const transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${port}`,
    auth: new HmacAuth(proof),
    autoReconnect: false,
  });
  const bus = createBusInstance({ transports: [transport] });
  if (registerContract) bus.registerNamespace(JobRunOutcomeNamespace);
  onTestFinished(() => bus.disconnect());
  await bus.connect();
  const call = bus.own('root');
  return {
    bus,
    call,
    transport,
    submit: (result: JobRunResult) => bus.request(call, subject, { result }),
    disconnect: () => bus.disconnect(),
  };
}

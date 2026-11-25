import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BusRequestMessage, ConnectionLostError, createBusInstance, MakaioBus } from '@makaio/bus-core';
import { HmacAuth, registerHmacIdentitySecret, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  ACCESS_DENIED_ERROR_CODE,
  type AccessDenied,
  AccessSubjects,
  CoreDenialPlace,
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
  SubjectSendRightContextSchema,
  SubjectSubscribeRightContextSchema,
  type RightsSourceContribution,
} from '@makaio/contracts';
import { AccessDeniedError } from '@makaio/contracts/access';
import { RightDenialReason, SUBJECT_HANDLE_RIGHT, SubjectHandleRightContextSchema } from '@makaio/contracts/rights';
import { createBusNamespace, type CallContextRecord, type Party, type PartyRef } from '@makaio/core';
import { BootNamespace, BootSubjects, ExtensionNamespace, ExtensionSubjects } from '@makaio/kernel';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bootMakaioRuntime, type MakaioRuntime } from '../boot.js';
import { ExplicitDescriptorDiscovery } from '../extension-discovery.js';
import { closeHttpServer, listenOnLoopback } from './http-test-helpers.js';

interface RightsFixtureExtension extends KernelMakaioExtension {
  readonly rightsSources: readonly RightsSourceContribution[];
}

const EXTENSION = 'external-rights-fixture';
const CALLER = { kind: 'test.peer', id: 'subscriber' } satisfies Party;
const ATTESTED = { kind: 'test.member', id: 'delegated' } satisfies Party;
const SEND_SOURCE = `${EXTENSION}.send`;
const SUBSCRIBE_SOURCE = `${EXTENSION}.subscribe`;
const HANDLE_SOURCE = `${EXTENSION}.handle`;
const REASON = 'fixture-policy';
const REQUEST_TIMEOUT_MS = 2_000;
const update = z.object({ recipient: z.string(), sequence: z.number(), projection: z.unknown().optional() });
const request = {
  request: z.object({}),
  response: z.object({ caller: z.string(), principal: z.string() }),
};
const namespace = createBusNamespace(EXTENSION, {
  probe: request,
  denied: request,
  served: request,
  sourceFailure: request,
  updated: update,
  hidden: update,
});
const { subjects } = namespace;
const lateNamespace = createBusNamespace('external-rights-late', { updated: update, cancelled: update });
const LATE_PATTERN = `${lateNamespace.name}.updated`;
const CANCELLED_PATTERN = `${lateNamespace.name}.cancelled`;
const lateExtension: KernelMakaioExtension = {
  name: lateNamespace.name,
  displayName: 'Late namespace owner',
  version: '1.0.0',
  namespaces: [lateNamespace],
};
const BOOT_STATE_PATTERN = `${BootNamespace.name}.getState`;
const UPDATE_PATTERN = `${namespace.name}.*`;
const HIDDEN_PATTERN = `${namespace.name}.hidden`;
const SERVED_PATTERN = `${namespace.name}.served`;
const uiNamespace = createBusNamespace('ui', { ready: update, hidden: update });
const UI_READY_PATTERN = `${uiNamespace.name}.ready`;
const UI_HIDDEN_PATTERN = `${uiNamespace.name}.hidden`;

describe('external bus rights', () => {
  const server = createServer();
  const localDenials: AccessDenied[] = [];
  const deliveryCalls: CallContextRecord[] = [];
  const deliveryPayloads: unknown[] = [];
  let acceptedPatternCall: CallContextRecord | undefined;
  let home: string | undefined;
  let runtime: MakaioRuntime | undefined;
  let client: WebSocketClientTransport;
  let peerBus: ReturnType<typeof createBusInstance>;
  let startupResult: unknown;
  let startupProbe: Promise<unknown>;
  let startupEvent: Promise<unknown>;
  let startupReadOnly: Promise<unknown>;
  let createPeer: () => WebSocketClientTransport;
  let notifySourceChanged: (() => void) | undefined;
  let removeDenialListener: (() => void) | undefined;
  let unregisterIdentity: (() => void) | undefined;
  let allowProbe = true;
  let probeQuestions = 0;
  let deniedHandlerCalls = 0;
  let hiddenAdmissionChecks = 0;
  let lateAdmissionChecks = 0;

  const extension: RightsFixtureExtension = {
    name: EXTENSION,
    displayName: 'External rights fixture',
    version: '1.0.0',
    critical: true,
    namespaces: [namespace],
    rightsSources: [
      {
        source: SEND_SOURCE,
        description: 'Grant the peer access to the probe while enabled.',
        rights: [SUBJECT_SEND_RIGHT],
        payloadIndependent: [SUBJECT_SEND_RIGHT],
        async answer({ call, context }) {
          const { subject } = SubjectSendRightContextSchema.parse(context);
          if (call.caller.id !== CALLER.id) return { granted: true };
          if (subject === `${namespace.name}.sourceFailure`) throw new Error('Fixture answer source failed');
          if (subject === `${namespace.name}.probe`) {
            probeQuestions += 1;
            if (allowProbe) return { granted: true };
          } else if (subject !== `${namespace.name}.denied` || call.principal.id !== CALLER.id) {
            return { granted: true };
          }
          return { granted: false, reason: REASON };
        },
      },
      {
        source: SUBSCRIBE_SOURCE,
        description: 'Deliver only updates addressed to the subscriber.',
        rights: [SUBJECT_SUBSCRIBE_RIGHT],
        requiresPayload: [SUBJECT_SUBSCRIBE_RIGHT],
        async answer({ call, context }) {
          const { pattern, subject, payload } = SubjectSubscribeRightContextSchema.parse(context);
          const target = pattern ?? subject;
          if (target === UI_HIDDEN_PATTERN) return { granted: false, reason: REASON };
          if (target === HIDDEN_PATTERN) {
            if (pattern !== undefined) hiddenAdmissionChecks += 1;
            return { granted: false, reason: REASON };
          }
          if (subject === SERVED_PATTERN) return { granted: false, reason: REASON };
          if (pattern === LATE_PATTERN) lateAdmissionChecks += 1;
          if (pattern === UPDATE_PATTERN) acceptedPatternCall = call;
          if (subject === `${namespace.name}.updated`) {
            deliveryCalls.push(call);
            deliveryPayloads.push(payload);
            if (update.parse(payload).recipient !== call.principal.id) return { granted: false, reason: REASON };
          }
          return { granted: true };
        },
      },
      {
        source: HANDLE_SOURCE,
        description: 'Grant the peer permission to handle the served subject.',
        rights: [SUBJECT_HANDLE_RIGHT],
        async answer({ context }) {
          const { pattern, subject } = SubjectHandleRightContextSchema.parse(context);
          return [SERVED_PATTERN, BOOT_STATE_PATTERN].includes(pattern ?? subject ?? '')
            ? { granted: true }
            : { granted: false, reason: REASON };
        },
      },
    ],
    /**
     * Install handlers and expose the source's change notification to the test.
     * @param ctx - Context provided by the running host.
     * @returns Service responsible for removing its bus handlers.
     */
    create(ctx: KernelExtensionContext) {
      const removeProbe = ctx.bus.on(subjects.probe, ({ call, setResult }) => {
        setResult({ caller: call.caller.id, principal: call.principal.id });
      });
      const removeDenied = ctx.bus.on(subjects.denied, ({ call, setResult }) => {
        deniedHandlerCalls += 1;
        setResult({ caller: call.caller.id, principal: call.principal.id });
      });
      notifySourceChanged = () => ctx.rights.sourceChanged(SEND_SOURCE);
      return {
        async init() {
          peerBus = createBusInstance({ transports: [client] });
          peerBus.registerNamespaces([namespace, BootNamespace, uiNamespace]);
          await peerBus.connect();
          const uiReady = new AbortController();
          void peerBus.once(uiNamespace.subjects.ready, { signal: uiReady.signal }).catch(() => undefined);
          startupEvent = peerBus.once(BootSubjects.complete, { timeoutMs: REQUEST_TIMEOUT_MS }).then(
            ({ payload }) => payload,
            (error: unknown) => error,
          );
          startupReadOnly = checkBootReadOnly().catch((error: unknown) => error);
          await startupReadOnly;
          startupProbe = peerBus.request(BootSubjects.getState, {}).catch((error: unknown) => error);
          startupResult = await sendRequest(ExtensionSubjects.setEnabled.subject, ExtensionNamespace.name, undefined, {
            payload: { name: EXTENSION, enabled: false },
            timeout: REQUEST_TIMEOUT_MS,
          }).catch((error: unknown) => error);
          uiReady.abort();
        },
        destroy() {
          removeDenied();
          removeProbe();
        },
      };
    },
  };

  beforeAll(async () => {
    for (const name of ['MAKAIO_SKIP_EXTENSIONS', 'MAKAIO_DATABASE_URL', 'MAKAIO_DATABASE_PATH']) {
      vi.stubEnv(name, undefined);
    }
    const extensionPath = await mkdtemp(join(tmpdir(), 'makaio-external-rights-'));
    home = extensionPath;
    const port = await listenOnLoopback(server);
    const secret = randomUUID();
    unregisterIdentity = registerHmacIdentitySecret(CALLER.id, secret, {
      partyKind: CALLER.kind,
      attestingRole: 'local-cli',
    });
    createPeer = () =>
      new WebSocketClientTransport({
        url: `ws://127.0.0.1:${port}/bus`,
        auth: new HmacAuth({ secret, identityId: CALLER.id }),
        autoReconnect: false,
      });
    client = createPeer();
    await client.subscribe(`${namespace.name}.updated`);
    await client.subscribe(HIDDEN_PATTERN);
    runtime = await bootMakaioRuntime({
      httpServer: server,
      makaioHome: home,
      auth: new HmacAuth({
        secret: randomUUID(),
        resolveSecret: (id) => (id === CALLER.id ? secret : null),
        resolveParty: (id) => (id === CALLER.id ? CALLER : null),
      }),
      discovery: new ExplicitDescriptorDiscovery(
        [extension, lateExtension].map((pkg) => ({
          descriptor: {
            name: pkg.name,
            displayName: pkg.displayName,
            version: pkg.version,
            makaio: { framework: '>=1.0.0' },
            entrypoints: { server: true },
          },
          extensionPath,
          source: 'local',
          preloadedModule: { default: pkg },
        })),
      ),
      frameworkVersion: '3.0.0',
    });
    removeDenialListener = runtime.bus.on(AccessSubjects.denied, ({ payload }) => {
      localDenials.push(payload);
    });
  });

  afterAll(async () => {
    removeDenialListener?.();
    try {
      peerBus?.disconnect();
      await client?.disconnect();
    } finally {
      try {
        await runtime?.shutdown();
      } finally {
        unregisterIdentity?.();
        vi.unstubAllEnvs();
        if (server.listening) await closeHttpServer(server);
        if (home !== undefined) await rm(home, { recursive: true, force: true });
      }
    }
  });

  /**
   * Send a real correlated request through the authenticated socket.
   * @param subject - Request name within its namespace.
   * @param domain - Namespace placed on the wire.
   * @param principal - Principal attested by the authenticated connection.
   * @param options - Payload and optional wire budget.
   * @returns The result received by the peer.
   */
  function sendRequest(
    subject: string,
    domain: string = namespace.name,
    principal?: PartyRef,
    options: Pick<BusRequestMessage, 'payload' | 'timeout'> = { payload: {} },
  ): Promise<unknown> {
    return client.send({
      type: 'request',
      namespace: domain,
      subject,
      messageId: randomUUID(),
      correlationId: randomUUID(),
      ...options,
      ...(principal === undefined ? {} : { metadata: { principal } }),
    });
  }

  it('records discarded replies in the local denial diagnostic without debug', async () => {
    const correlationId = randomUUID();
    const peerDiagnostic = { at: CoreDenialPlace.boundary, ctx: { caller: CALLER, principal: CALLER } };
    await client.send({ type: 'response', correlationId, result: {} });
    await vi.waitFor(() => {
      expect(localDenials).toContainEqual({ ...peerDiagnostic, reason: 'response-without-delivery' });
    });

    await client.send({ type: 'broadcast-response', correlationId, results: [] });
    await vi.waitFor(() => {
      expect(localDenials).toContainEqual({ ...peerDiagnostic, reason: 'broadcast-response-without-delivery' });
    });
  });

  it('passes the authenticated caller and principal to the handler for a granted request', async () => {
    await expect(sendRequest('probe')).resolves.toEqual({ caller: CALLER.id, principal: CALLER.id });
  });

  it('delivers the runtime boot completion event to a client connected during startup', async () => {
    expect(await startupEvent).toMatchObject({
      failedServices: expect.any(Array),
      totalDurationMs: expect.any(Number),
    });
    expect(await startupProbe).toMatchObject({ complete: false });
  });

  /**
   * Observe the host decision and both event destinations over a real connection.
   * @returns The event decision, event destinations, and handler registration outcome.
   */
  async function checkBootReadOnly() {
    const observer = createPeer();
    const ready = BootSubjects.service.ready;
    const fullSubject = `${BootNamespace.name}.${ready.subject}`;
    const candidate = { name: randomUUID(), displayName: 'Candidate', durationMs: 0 };
    const marker = { ...candidate, displayName: 'Host marker' };
    const decision = Promise.withResolvers<unknown>();
    const markerReceived = Promise.withResolvers<void>();
    const observed = new Set<string>();
    const handled: unknown[] = [];
    const removeHost = MakaioBus.on(
      ready,
      ({ payload }) => {
        handled.push(payload);
        if (payload.displayName === candidate.displayName) decision.resolve('delivered');
      },
      { filter: { name: candidate.name } },
    );
    const removeDiagnostic = MakaioBus.on(AccessSubjects.denied, ({ payload }) => {
      if (payload.at === CoreDenialPlace.send && payload.subject === fullSubject) decision.resolve(payload);
    });
    observer.onReceive(async (message) => {
      if (message.type !== 'event' || message.namespace !== BootNamespace.name || message.subject !== ready.subject) {
        return;
      }
      const payload = z.object({ name: z.string(), displayName: z.string() }).parse(message.payload);
      if (payload.name !== candidate.name) return;
      observed.add(payload.displayName);
      if (payload.displayName === marker.displayName) markerReceived.resolve();
    });

    try {
      await observer.connect();
      await observer.ready;
      await observer.subscribe(fullSubject);
      await peerBus.emit(ready, candidate);
      const handler = await client.subscribe(BOOT_STATE_PATTERN, undefined, [100]).then(
        async () => {
          await client.unsubscribe(BOOT_STATE_PATTERN);
          return 'registered';
        },
        (error: unknown) => error,
      );
      const broadcast = await client
        .send({
          type: 'broadcast',
          namespace: BootNamespace.name,
          subject: BootSubjects.getState.subject,
          messageId: randomUUID(),
          correlationId: randomUUID(),
          payload: {},
          timeout: REQUEST_TIMEOUT_MS,
        })
        .catch((error: unknown) => error);
      const event = await decision.promise;
      await MakaioBus.emit(ready, marker);
      await markerReceived.promise;
      return { event, handler, broadcast, handled, observed: [...observed] };
    } finally {
      removeDiagnostic();
      removeHost();
      await observer.disconnect();
    }
  }

  it.each(['starting', 'ready'] as const)('keeps startup observation read-only while %s', async (phase) => {
    const outcome = phase === 'starting' ? await startupReadOnly : await checkBootReadOnly();
    expect(outcome).toMatchObject({
      event: { at: CoreDenialPlace.send, reason: 'startup-observable-read-only' },
      handler: {
        code: ACCESS_DENIED_ERROR_CODE,
        data: { at: CoreDenialPlace['register-handler'], reason: 'startup-observable-read-only' },
      },
      broadcast: {
        code: ACCESS_DENIED_ERROR_CODE,
        data: { at: CoreDenialPlace.send, reason: 'startup-observable-read-only' },
      },
      handled: [expect.objectContaining({ displayName: 'Host marker' })],
      observed: ['Host marker'],
    });
  });

  it('rejects a state-changing kernel request during startup', () => {
    expect(startupResult).toBeInstanceOf(AccessDeniedError);
    expect(startupResult).toMatchObject({
      code: ACCESS_DENIED_ERROR_CODE,
      data: { at: CoreDenialPlace.send, reason: 'host-not-ready' },
    });
  });

  it('restores authorized replay patterns after startup and discards policy denials', async () => {
    if (runtime === undefined) throw new Error('Runtime did not start');
    const received: string[] = [];
    const remove = client.onReceive(async (message) => {
      if (message.type === 'event' && message.namespace === namespace.name) received.push(message.subject);
    });
    const payload = { recipient: CALLER.id, sequence: 0 };
    try {
      expect(hiddenAdmissionChecks).toBe(1);
      await runtime.bus.emit(subjects.hidden, payload, { transports: ['websocket'] });
      await runtime.bus.emit(subjects.updated, payload, { transports: ['websocket'] });
      await vi.waitFor(() => expect(received).toEqual(['updated']));
      expect(hiddenAdmissionChecks).toBe(1);
    } finally {
      remove();
      await client.unsubscribe(`${namespace.name}.updated`);
      await client.unsubscribe(HIDDEN_PATTERN);
      deliveryCalls.length = 0;
      deliveryPayloads.length = 0;
    }
  });

  it('rechecks replay for a reactivated owner and honours intervening unsubscription', async () => {
    if (runtime === undefined) throw new Error('Runtime did not start');
    const { bus, coordinator } = runtime;
    const readyPattern = `${namespace.name}.updated`;
    const payload = { recipient: CALLER.id, sequence: 0 };
    const received: string[] = [];
    let remove: (() => void) | undefined;
    const checksBeforeReconnect = hiddenAdmissionChecks;
    try {
      await expect(coordinator.applyExtensionTransition(lateExtension.name, false)).resolves.toBe('applied');
      await client.disconnect();
      await client.subscribe(LATE_PATTERN);
      await client.subscribe(CANCELLED_PATTERN);
      await client.subscribe(HIDDEN_PATTERN);
      await client.connect();
      await client.ready;
      remove = client.onReceive(async (message) => {
        if (message.type === 'event' && message.namespace === lateNamespace.name) received.push(message.subject);
      });
      await client.subscribe(readyPattern);
      await client.unsubscribe(CANCELLED_PATTERN);
      expect(lateAdmissionChecks).toBe(0);
      expect(hiddenAdmissionChecks).toBe(checksBeforeReconnect + 1);

      await expect(coordinator.applyExtensionTransition(lateExtension.name, true)).resolves.toBe('applied');
      await vi.waitFor(() => expect(lateAdmissionChecks).toBe(1));
      await client.unsubscribe(readyPattern);
      await bus.emit(lateNamespace.subjects.cancelled, payload, { transports: ['websocket'] });
      await bus.emit(lateNamespace.subjects.updated, payload, { transports: ['websocket'] });
      await vi.waitFor(() => expect(received).toEqual(['updated']));
      expect(hiddenAdmissionChecks).toBe(checksBeforeReconnect + 1);
    } finally {
      remove?.();
      await client.unsubscribe(LATE_PATTERN);
      await client.unsubscribe(HIDDEN_PATTERN);
    }
  });

  it('acknowledges subscriptions before registration and diagnoses a later policy denial', async () => {
    if (runtime === undefined) throw new Error('Runtime did not start');
    const { bus } = runtime;
    const received: string[] = [];
    const remove = client.onReceive(async (message) => {
      if (message.type === 'event' && message.namespace === uiNamespace.name) received.push(message.subject);
    });
    const payload = { recipient: CALLER.id, sequence: 0 };
    try {
      await client.subscribe(UI_READY_PATTERN);
      await client.subscribe(UI_HIDDEN_PATTERN);
      MakaioBus.registerNamespaces([uiNamespace]);
      // The unsubscribe acknowledgement is ordered after the registration-triggered recheck.
      await client.unsubscribe(CANCELLED_PATTERN);
      await bus.emit(uiNamespace.subjects.hidden, payload, { transports: ['websocket'] });
      await bus.emit(uiNamespace.subjects.ready, payload, { transports: ['websocket'] });
      await vi.waitFor(() => expect(received).toEqual(['ready']));
      expect(localDenials).toContainEqual(
        expect.objectContaining({
          at: CoreDenialPlace.subscribe,
          right: SUBJECT_SUBSCRIBE_RIGHT,
          reason: REASON,
          by: SUBSCRIBE_SOURCE,
        }),
      );
    } finally {
      remove();
      await Promise.all([client.unsubscribe(UI_READY_PATTERN), client.unsubscribe(UI_HIDDEN_PATTERN)]);
    }
  });

  it.each([namespace.name, 'external-rights-unowned'])('refuses an unregistered subject in %s', async (domain) => {
    await expect(sendRequest('unregistered', domain)).rejects.toMatchObject({
      code: ACCESS_DENIED_ERROR_CODE,
      data: { at: CoreDenialPlace.send, reason: 'subject-not-registered' },
    });
  });

  it('refuses a request when its answer source throws', async () => {
    await expect(sendRequest('sourceFailure')).rejects.toMatchObject({
      code: ACCESS_DENIED_ERROR_CODE,
      data: {
        at: CoreDenialPlace.send,
        right: SUBJECT_SEND_RIGHT,
        reason: RightDenialReason.sourceUnavailable,
        by: SEND_SOURCE,
      },
    });
  });

  it('denies sending before the handler runs and keeps the call context in the local diagnostic', async () => {
    const data = { at: CoreDenialPlace.send, right: SUBJECT_SEND_RIGHT, reason: REASON, by: SEND_SOURCE };
    const result = sendRequest('denied', namespace.name, ATTESTED);
    await expect(result).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(result).rejects.toMatchObject({ code: ACCESS_DENIED_ERROR_CODE, data });
    await expect(result).rejects.not.toHaveProperty('data.ctx');
    expect(deniedHandlerCalls).toBe(0);
    await vi.waitFor(() => {
      expect(localDenials).toContainEqual(
        expect.objectContaining({
          ...data,
          subject: `${namespace.name}.denied`,
          ctx: { caller: CALLER, principal: ATTESTED, attestedBy: CALLER },
        }),
      );
    });
  });

  it('reports a denied subscription to the peer and in the local diagnostic', async () => {
    const data = {
      at: CoreDenialPlace.subscribe,
      right: SUBJECT_SUBSCRIBE_RIGHT,
      reason: REASON,
      by: SUBSCRIBE_SOURCE,
    };
    const subscription = client.subscribe(HIDDEN_PATTERN);
    await expect(subscription).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(subscription).rejects.toMatchObject({ code: ACCESS_DENIED_ERROR_CODE, data });
    expect(client.getSubscriptions().has(HIDDEN_PATTERN)).toBe(false);
    await vi.waitFor(() => {
      expect(localDenials).toContainEqual(
        expect.objectContaining({ ...data, ctx: { caller: CALLER, principal: CALLER } }),
      );
    });
  });

  it('rejects once immediately when the acknowledged subscription is denied', async () => {
    const lifetime = new AbortController();
    const outcome = peerBus.once(subjects.hidden, { signal: lifetime.signal });
    try {
      await expect(outcome).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(outcome).rejects.toMatchObject({
        code: ACCESS_DENIED_ERROR_CODE,
        data: { at: CoreDenialPlace.subscribe, right: SUBJECT_SUBSCRIBE_RIGHT, reason: REASON },
      });
    } finally {
      lifetime.abort();
    }
  });

  it('checks every delivered payload using the subscription call', async () => {
    const received: unknown[] = [];
    const removeListener = client.onReceive(async (message) => {
      if (message.type === 'event' && message.namespace === namespace.name && message.subject === 'updated') {
        received.push(message.payload);
      }
    });

    try {
      await client.subscribe(UPDATE_PATTERN);
      const first = { recipient: CALLER.id, sequence: 1 };
      const denied = { recipient: 'different-recipient', sequence: 2 };
      const last = { recipient: CALLER.id, sequence: 3 };
      const bus = runtime?.bus;
      expect(bus).toBeDefined();
      const timestamp = new Date('2026-01-01T00:00:00.000Z');
      for (const payload of [first, denied, last]) {
        await bus?.emit(
          subjects.updated,
          { ...payload, projection: { timestamp, absent: undefined } },
          {
            transports: ['websocket'],
          },
        );
      }
      const projected = [first, denied, last].map((payload) => ({
        ...payload,
        projection: { timestamp: timestamp.toISOString() },
      }));

      const subscriptionCall = { caller: CALLER, principal: CALLER };
      await vi.waitFor(() => expect(received).toEqual([projected[0], projected[2]]));
      expect(acceptedPatternCall).toEqual(subscriptionCall);
      expect(deliveryPayloads).toEqual(projected);
      expect(deliveryCalls).toEqual([subscriptionCall, subscriptionCall, subscriptionCall]);
      await vi.waitFor(() => {
        expect(localDenials).toContainEqual(
          expect.objectContaining({
            at: CoreDenialPlace.deliver,
            right: SUBJECT_SUBSCRIBE_RIGHT,
            subject: `${namespace.name}.updated`,
            reason: REASON,
            by: SUBSCRIBE_SOURCE,
            ctx: subscriptionCall,
          }),
        );
      });
    } finally {
      removeListener();
      await client.unsubscribe(UPDATE_PATTERN);
    }
  });

  it('invalidates a cached grant on the same connection when the source changes', async () => {
    await expect(sendRequest('probe')).resolves.toEqual({ caller: CALLER.id, principal: CALLER.id });
    const answered = probeQuestions;
    expect(answered).toBeGreaterThan(0);

    allowProbe = false;
    try {
      await expect(sendRequest('probe')).resolves.toEqual({ caller: CALLER.id, principal: CALLER.id });
      expect(probeQuestions).toBe(answered);

      expect(notifySourceChanged).toBeDefined();
      notifySourceChanged?.();
      await expect(sendRequest('probe')).rejects.toMatchObject({
        code: ACCESS_DENIED_ERROR_CODE,
        data: { at: CoreDenialPlace.send, right: SUBJECT_SEND_RIGHT, reason: REASON, by: SEND_SOURCE },
      });
      expect(probeQuestions).toBe(answered + 1);
    } finally {
      allowProbe = true;
    }
  });

  it('keeps a peer with only subscription rights out of request routing', async () => {
    const pattern = `${namespace.name}.probe`;
    const received: unknown[] = [];
    const removeHandler = client.onReceive(async (message) => {
      if (message.type === 'request') received.push(message);
    });
    try {
      await client.subscribe(pattern);
      const handler = client.subscribe(pattern, undefined, [100]);
      await expect(handler).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(handler).rejects.toMatchObject({
        code: ACCESS_DENIED_ERROR_CODE,
        data: {
          at: CoreDenialPlace['register-handler'],
          right: SUBJECT_HANDLE_RIGHT,
          reason: REASON,
          by: HANDLE_SOURCE,
        },
      });
      if (runtime === undefined) throw new Error('Runtime did not start');
      const hostResult = await runtime.bus.request(subjects.probe, {});
      expect(hostResult.caller).not.toBe(CALLER.id);
      expect(received).toEqual([]);
    } finally {
      removeHandler();
      await client.unsubscribe(pattern);
    }
  });

  it('delivers a request to a handler using its handling right', async () => {
    const handlerResult = { caller: 'host', principal: 'host' };
    const removeHandler = client.onReceive(async (message) => {
      if (message.type === 'request' && message.namespace === namespace.name && message.subject === 'served') {
        await client.send({ type: 'response', correlationId: message.correlationId, result: handlerResult });
      }
    });
    try {
      await client.subscribe(SERVED_PATTERN, undefined, [100]);
      if (runtime === undefined) throw new Error('Runtime did not start');
      await expect(runtime.bus.request(subjects.served, {})).resolves.toEqual(handlerResult);
    } finally {
      removeHandler();
      await client.unsubscribe(SERVED_PATTERN);
    }
  });

  it('ends a delivery when its connection closes, even if the handler replies after reconnecting', async () => {
    const delivery = Promise.withResolvers<BusRequestMessage>();
    const removeHandler = client.onReceive(async (message) => {
      if (message.type === 'request' && message.namespace === namespace.name && message.subject === 'served') {
        delivery.resolve(message);
      }
    });
    try {
      await client.subscribe(SERVED_PATTERN, undefined, [100]);
      if (runtime === undefined) throw new Error('Runtime did not start');
      const outcome = runtime.bus
        .request(subjects.served, {}, { timeout: REQUEST_TIMEOUT_MS })
        .catch((error: unknown) => error);
      const request = await delivery.promise;
      await client.disconnect();
      await client.connect();
      await client.send({
        type: 'response',
        correlationId: request.correlationId,
        result: { caller: 'host', principal: 'host' },
      });
      await expect(outcome).resolves.toBeInstanceOf(ConnectionLostError);
    } finally {
      removeHandler();
      await client.unsubscribe(SERVED_PATTERN);
    }
  });
});

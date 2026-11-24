import { NAMESPACE_ALREADY_OWNED } from '@makaio/contracts/extension';
import { collectorOnlySubject, createBusNamespace, hostLocalRequest, localSubject } from '@makaio/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance, ValidationError } from '../index.js';
import {
  busContextOf,
  hasNamespace,
  HOST_NAMESPACE_HOLDER,
  leaseNamespace,
  listOwners,
  namespaceOf,
  NamespaceOwnershipError,
  ownerOf,
  type NamespaceHolder,
} from '../kernel-api.js';
import { MockTransport } from './helpers/transport-fixtures.js';

const FirstHolder = { kind: 'extension', extension: 'example.first' } satisfies NamespaceHolder;
const SecondHolder = { kind: 'extension', extension: 'example.second' } satisfies NamespaceHolder;
const EventSchema = z.object({ id: z.string() });
const OwnershipNamespace = createBusNamespace('example:ownership', { event: EventSchema });

describe('namespace ownership', () => {
  it('registers host namespaces via both public registration methods', () => {
    const bus = createBusInstance();
    const single = createBusNamespace('example:single', { event: EventSchema });
    const bulk = createBusNamespace('example:bulk', { event: EventSchema });

    bus.registerNamespace(single);
    bus.registerNamespaces([bulk]);

    expect(ownerOf(bus, single.name)).toEqual(HOST_NAMESPACE_HOLDER);
    expect(ownerOf(bus, bulk.name)).toEqual(HOST_NAMESPACE_HOLDER);
    expect(hasNamespace(bus, single.name)).toBe(true);
    expect(hasNamespace(bus, bulk.name)).toBe(true);
    expect(hasNamespace(bus, `${single.name}.unknown`)).toBe(false);
    expect(bus).not.toHaveProperty('leaseNamespace');
    expect(() => leaseNamespace(bus, single, FirstHolder)).toThrow(
      expect.objectContaining({
        code: NAMESPACE_ALREADY_OWNED,
        owner: HOST_NAMESPACE_HOLDER,
        requester: FirstHolder,
      }),
    );
  });

  it('rejects a second holder and identifies both parties', () => {
    const bus = createBusInstance();
    leaseNamespace(bus, OwnershipNamespace, FirstHolder);

    expect(ownerOf(bus, OwnershipNamespace.name)).toEqual(FirstHolder);
    expect(() => leaseNamespace(bus, OwnershipNamespace, SecondHolder)).toThrow(NamespaceOwnershipError);
    expect(() => leaseNamespace(bus, OwnershipNamespace, SecondHolder)).toThrow(
      expect.objectContaining({
        code: 'namespace-already-owned',
        namespace: OwnershipNamespace.name,
        owner: FirstHolder,
        requester: SecondHolder,
        message: expect.stringMatching(/example\.first.*example\.second/),
      }),
    );
    expect(() => bus.registerNamespace(OwnershipNamespace)).toThrow(
      expect.objectContaining({
        code: 'namespace-already-owned',
        owner: FirstHolder,
        requester: HOST_NAMESPACE_HOLDER,
      }),
    );
    expect(ownerOf(bus, OwnershipNamespace.name)).toEqual(FirstHolder);
  });

  it.each(['makaio:x', 'channel:x'])('reserves %s for the host before registration', (domain) => {
    const bus = createBusInstance();
    const definition = createBusNamespace(domain, { event: EventSchema });

    expect(ownerOf(bus, 'channel:abc')).toEqual(HOST_NAMESPACE_HOLDER);
    expect(ownerOf(bus, domain)).toEqual(HOST_NAMESPACE_HOLDER);
    expect(hasNamespace(bus, domain)).toBe(false);
    expect(listOwners(bus)).not.toContainEqual({ namespace: domain, owner: HOST_NAMESPACE_HOLDER });
    expect(() => leaseNamespace(bus, definition, FirstHolder)).toThrow(
      expect.objectContaining({
        code: 'namespace-already-owned',
        owner: HOST_NAMESPACE_HOLDER,
        requester: FirstHolder,
      }),
    );
    expect(hasNamespace(bus, domain)).toBe(false);
    bus.registerNamespace(definition);
    expect(hasNamespace(bus, domain)).toBe(true);
    expect(ownerOf(bus, domain)).toEqual(HOST_NAMESPACE_HOLDER);
  });

  it('keeps a namespace registered until the last claim by its holder is released', () => {
    const bus = createBusInstance();
    const first = leaseNamespace(bus, OwnershipNamespace, FirstHolder);
    const second = leaseNamespace(bus, OwnershipNamespace, { ...FirstHolder });

    first.release();
    first.release();
    expect(hasNamespace(bus, OwnershipNamespace.name)).toBe(true);
    expect(ownerOf(bus, OwnershipNamespace.name)).toEqual(FirstHolder);

    second.release();
    expect(hasNamespace(bus, OwnershipNamespace.name)).toBe(false);
    expect(ownerOf(bus, OwnershipNamespace.name)).toBeUndefined();
  });

  it('keeps a public host registration after an earlier host lease is released', () => {
    const bus = createBusInstance();
    const lease = leaseNamespace(bus, OwnershipNamespace, HOST_NAMESPACE_HOLDER);
    bus.registerNamespace(OwnershipNamespace);

    lease.release();
    expect(hasNamespace(bus, OwnershipNamespace.name)).toBe(true);
    expect(ownerOf(bus, OwnershipNamespace.name)).toEqual(HOST_NAMESPACE_HOLDER);
  });

  it('makes old leases harmless after release and reassignment', () => {
    const bus = createBusInstance();
    const first = leaseNamespace(bus, OwnershipNamespace, FirstHolder);
    const duplicate = leaseNamespace(bus, OwnershipNamespace, { ...FirstHolder });

    duplicate.release();
    expect(ownerOf(bus, OwnershipNamespace.name)).toEqual(FirstHolder);
    first.release();
    expect(ownerOf(bus, OwnershipNamespace.name)).toBeUndefined();
    expect(hasNamespace(bus, OwnershipNamespace.name)).toBe(false);

    const next = leaseNamespace(bus, OwnershipNamespace, SecondHolder);
    first.release();
    duplicate.release();
    expect(ownerOf(bus, OwnershipNamespace.name)).toEqual(SecondHolder);
    next.release();
    next.release();
    expect(ownerOf(bus, OwnershipNamespace.name)).toBeUndefined();
  });

  it('removes leased schemas and namespace defaults while retaining locality on release', async () => {
    const bus = createBusInstance();
    const registry = busContextOf(bus).namespaceRegistry;
    const domain = 'example:release';
    const request = { request: z.object({ input: z.string() }), response: z.object({ output: z.string() }) };
    const definition = createBusNamespace(
      domain,
      {
        call: request,
        local: localSubject(EventSchema),
        collector: collectorOnlySubject(EventSchema),
        hostRequest: hostLocalRequest(request),
      },
      { defaultTransports: 'local-only' },
    );
    const alternate = createBusNamespace(domain, { call: { ...request, request: z.object({ input: z.number() }) } });
    const result = { output: 'handled' };
    const lease = leaseNamespace(bus, definition, FirstHolder);
    const unsubscribe = bus.on(definition.subjects.call, (ctx) => ctx.setResult(result));
    // ORIGIN: The test sends a request using the same bus before and after release.
    const call = bus.own('root');
    const fullSubject = `${domain}.call`;

    try {
      expect(registry.isLocalSubject(`${domain}.local`)).toBe(true);
      expect(registry.isCollectorOnlySubject(`${domain}.collector`)).toBe(true);
      expect(registry.isHostLocalRequestSubject(`${domain}.hostRequest`)).toBe(true);
      expect(registry.getDefaultTransports(fullSubject)).toBe('local-only');
      await expect(bus.request(call, alternate.subjects.call, { input: 123 })).rejects.toBeInstanceOf(ValidationError);

      lease.release();

      expect(bus.getSchema(definition.subjects.call)).toBeUndefined();
      expect(registry.listRegisteredSubjects().filter((entry) => entry.namespace === domain)).toEqual([]);
      expect(registry.isRequestSubject(fullSubject)).toBe(false);
      expect(registry.isCollectorOnlySubject(`${domain}.collector`)).toBe(true);
      expect({
        local: registry.isLocalSubject(`${domain}.local`),
        hostLocalRequest: registry.isHostLocalRequestSubject(`${domain}.hostRequest`),
      }).toEqual({ local: true, hostLocalRequest: true });
      expect(registry.getDefaultTransports(fullSubject)).toBe('all');
      await expect(bus.request(call, alternate.subjects.call, { input: 123 })).resolves.toEqual(result);
    } finally {
      unsubscribe();
    }
  });

  it('delivers collector-only events locally after release without relaying them', async () => {
    const source = new MockTransport('source');
    const peer = new MockTransport('peer');
    const bus = createBusInstance({ transports: [source, peer] });
    const domain = 'example:collector';
    const original = createBusNamespace(domain, { event: collectorOnlySubject(EventSchema) });
    const replacement = createBusNamespace(domain, { event: EventSchema });
    const lease = leaseNamespace(bus, original, FirstHolder);
    const observer = vi.fn();
    const unsubscribe = bus.on(original.subjects.event, observer);
    const message = {
      type: 'event' as const,
      namespace: domain,
      subject: 'event',
      payload: { id: 'remote' },
      messageId: 'after-release',
    };

    try {
      lease.release();
      await source.simulateReceive(message);

      expect(observer).toHaveBeenCalledTimes(1);
      expect(peer.messages).toHaveLength(0);

      leaseNamespace(bus, replacement, SecondHolder);
      await source.simulateReceive({ ...message, messageId: 'after-reclaim' });

      expect(observer).toHaveBeenCalledTimes(2);
      expect(peer.messages).toEqual([expect.objectContaining({ type: 'event', messageId: 'after-reclaim' })]);
    } finally {
      unsubscribe();
      bus.disconnect();
    }
  });

  it('drops remote events after release until a new holder changes the routing marks', async () => {
    const transport = new MockTransport();
    const bus = createBusInstance({ transports: [transport] });
    const domain = 'example:local-ingress';
    const original = createBusNamespace(domain, {
      event: localSubject(EventSchema),
      retired: localSubject(EventSchema),
    });
    const replacement = createBusNamespace(domain, { event: EventSchema });
    const lease = leaseNamespace(bus, original, FirstHolder);
    const observer = vi.fn();
    const unsubscribe = bus.on(original.subjects.$all, observer, { handlerKind: 'event' });

    try {
      lease.release();
      expect(ownerOf(bus, domain)).toBeUndefined();
      expect(hasNamespace(bus, domain)).toBe(false);
      expect(listOwners(bus).map(({ namespace }) => namespace)).not.toContain(domain);
      expect(namespaceOf(bus, `${domain}.event`)).toBeUndefined();
      const message = {
        type: 'event' as const,
        namespace: domain,
        subject: 'event',
        payload: { id: 'remote' },
        messageId: 'after-release',
      };

      await transport.simulateReceive(message);
      expect(observer).not.toHaveBeenCalled();

      leaseNamespace(bus, replacement, SecondHolder);
      expect(ownerOf(bus, domain)).toEqual(SecondHolder);

      await transport.simulateReceive({ ...message, messageId: 'after-reclaim' });
      expect(observer).toHaveBeenCalledTimes(1);
      await transport.simulateReceive({ ...message, subject: 'retired', messageId: 'after-reclaim-retired' });
      expect(observer).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      bus.disconnect();
    }
  });

  it('drops validation configuration and accepts a different contract after release', () => {
    const bus = createBusInstance();
    const registry = busContextOf(bus).namespaceRegistry;
    const domain = 'example:validation';
    const original = createBusNamespace(domain, { event: localSubject(EventSchema) }, { busValidationMode: 'skip' });
    const replacement = createBusNamespace(domain, { event: EventSchema });
    const lease = leaseNamespace(bus, original, FirstHolder);

    expect(registry.getValidationConfig(`${domain}.event`)).toEqual({ mode: 'skip' });

    lease.release();

    expect(registry.getValidationConfig(`${domain}.event`)).toEqual({ mode: 'strict' });
    leaseNamespace(bus, replacement, SecondHolder);
    expect(ownerOf(bus, domain)).toEqual(SecondHolder);
    expect(registry.isLocalSubject(`${domain}.event`)).toBe(false);
  });

  it("restores another domain's exact subject when the later registration is released", () => {
    const bus = createBusInstance();
    const registry = busContextOf(bus).namespaceRegistry;
    const parent = createBusNamespace('example:parent', { 'child.event': localSubject(EventSchema) });
    const child = createBusNamespace('example:parent.child', { event: z.number() });
    const fullSubject = 'example:parent.child.event';
    leaseNamespace(bus, parent, FirstHolder);
    const lease = leaseNamespace(bus, child, SecondHolder);

    expect(namespaceOf(bus, fullSubject)).toBe(child.name);
    expect(bus.getSchema(fullSubject)).toEqual(child.schemas.event);
    expect(registry.isLocalSubject(fullSubject)).toBe(true);

    lease.release();

    expect(namespaceOf(bus, fullSubject)).toBe(parent.name);
    expect(bus.getSchema(fullSubject)).toEqual(EventSchema);
    expect(registry.isLocalSubject(fullSubject)).toBe(true);
  });

  it('lists registered namespaces and their holders in namespace order', () => {
    const bus = createBusInstance();
    bus.registerNamespace(createBusNamespace('example:z', { event: EventSchema }));
    leaseNamespace(bus, createBusNamespace('example:a', { event: EventSchema }), FirstHolder);
    bus.registerNamespace(createBusNamespace('example:m', { event: EventSchema }));

    expect(listOwners(bus).filter(({ namespace }) => namespace.startsWith('example:'))).toEqual([
      { namespace: 'example:a', owner: FirstHolder },
      { namespace: 'example:m', owner: HOST_NAMESPACE_HOLDER },
      { namespace: 'example:z', owner: HOST_NAMESPACE_HOLDER },
    ]);
  });

  it('prefers the exact subject record, then tries registered prefixes from the right', () => {
    const bus = createBusInstance();
    bus.registerNamespaces([
      createBusNamespace('a:b', { 'c.exact': EventSchema }),
      createBusNamespace('a:b.c', { event: EventSchema }),
      createBusNamespace('kernel', { event: EventSchema }),
      createBusNamespace('kernel:boot', { event: EventSchema }),
    ]);

    expect(namespaceOf(bus, 'a:b.c.exact')).toBe('a:b');
    expect(namespaceOf(bus, 'a:b.c.ad.hoc.x')).toBe('a:b.c');
    expect(namespaceOf(bus, 'a:b.other.deep.subject')).toBe('a:b');
    expect(namespaceOf(bus, 'kernel:boot.service.ready')).toBe('kernel:boot');
    expect(namespaceOf(bus, 'a:b-other.event')).toBeUndefined();
    expect(namespaceOf(bus, 'unknown')).toBeUndefined();
  });
});

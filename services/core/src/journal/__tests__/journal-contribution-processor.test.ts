import { createBusInstance } from '@makaio/bus-core';
import { type AccountResolverContribution, dep } from '@makaio/contracts';
import { createBusNamespace, journalSubject } from '@makaio/core';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { JournalActivationError, JournalContributionProcessor, SubjectDirectory } from '../index.js';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { constructContext } = useJournalHostFixture();

let coordinator: ExtensionCoordinator;
let directory: SubjectDirectory;
let journal: JournalContributionProcessor;

beforeEach(async () => {
  const bus = createBusInstance();
  coordinator = new ExtensionCoordinator(bus, {
    extensionContextBase: {
      constructContext,
      platform: 'linux',
      homedir: '/home/test',
      makaioHome: '/home/test/.makaio',
      username: 'test',
      machineId: 'machine-1',
      tryImport: async () => null,
    },
  });
  directory = new SubjectDirectory(bus, coordinator);
  await directory.init();
  journal = new JournalContributionProcessor(directory);
  coordinator.registerContributionProcessor(journal);
});

afterEach(async () => {
  try {
    await coordinator.shutdown();
  } finally {
    await directory.destroy();
  }
});

/**
 * Build a connector manifest for the coordinator.
 * @param name - Extension name.
 * @param fields - Additional declarations or service factory.
 * @returns The connector manifest.
 */
function extension(name: string, fields: Partial<KernelMakaioExtension> = {}): KernelMakaioExtension {
  return { name, displayName: name, version: '1.0.0', ...fields };
}

/**
 * Build a resolver contribution.
 * @param name - Full resolver name.
 * @returns A resolver that leaves accounts unmapped.
 */
function resolver(name: string): AccountResolverContribution {
  return { resolver: name, description: 'Look up accounts', resolve: async () => null };
}

const namespace = createBusNamespace('sample', {
  changed: journalSubject(z.boolean(), {
    retention: 'recorded',
    schemaVersion: '1',
    readOlder: { kind: 'as-recorded' },
  }),
  transient: z.boolean(),
});
const edge = { edge: 'connector.webhook', description: 'Receive changes', subjects: ['sample.changed'] };
const accountResolver = resolver('connector.accounts');

it('rejects an edge accepting another extension’s recorded subject', async () => {
  coordinator.load([
    extension('owner', { namespaces: [namespace] }),
    extension('connector', { edges: [edge], critical: true }),
  ]);

  const startup = coordinator.startAll();
  await expect(startup).rejects.toBeInstanceOf(JournalActivationError);
  await expect(startup).rejects.toMatchObject({
    code: 'name-not-owned',
    extension: 'connector',
    contribution: 'connector.webhook',
    message: expect.stringContaining('sample.changed'),
  });
});

it('rejects an edge accepting an owned volatile subject', async () => {
  coordinator.load([
    extension('connector', { namespaces: [namespace], edges: [{ ...edge, subjects: ['sample.transient'] }] }),
  ]);

  await coordinator.startAll();

  expect(coordinator.getInfo('connector')).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('subject-not-recorded'),
  });
  expect(journal.stagedEdgeFor('connector', edge.edge)).toBeUndefined();
});

it.each([
  { fields: { edges: [{ ...edge, edge: 'connector.' }] }, code: 'invalid-contribution-name' },
  { fields: { accountResolver: resolver('other.accounts') }, code: 'name-not-owned' },
])('rejects a contribution with a $code error', async ({ fields, code }) => {
  coordinator.load([extension('connector', { namespaces: [namespace], ...fields })]);

  await coordinator.startAll();

  expect(coordinator.getInfo('connector')).toMatchObject({ state: 'failed', error: expect.stringContaining(code) });
});

it('rejects duplicate edge names in one manifest without staging the first declaration', async () => {
  coordinator.load([extension('connector', { namespaces: [namespace], edges: [edge, edge] })]);

  await coordinator.startAll();

  expect(coordinator.getInfo('connector')).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('duplicate-edge'),
  });
  expect(journal.stagedEdgeFor('connector', edge.edge)).toBeUndefined();
});

it('rejects a duplicate edge name across extensions whose prefixes both match', async () => {
  const shared = { ...edge, edge: 'connector.inbound.webhook', subjects: [] };
  coordinator.load([
    extension('connector', { edges: [shared] }),
    extension('connector.inbound', { edges: [shared], dependencies: [dep('connector')] }),
  ]);

  await coordinator.startAll();

  expect(coordinator.getInfo('connector.inbound')).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('duplicate-edge'),
  });
  expect(journal.edgeFor('connector', shared.edge)).toEqual(shared);
  expect(journal.stagedEdgeFor('connector.inbound', shared.edge)).toBeUndefined();
});

it('rejects a second resolver and allows its owner to retry when the first stops', async () => {
  const alternate = resolver('alternate.accounts');
  coordinator.load([
    extension('connector', { accountResolver }),
    extension('alternate', {
      accountResolver: alternate,
      dependencies: [dep('connector', '^1.0.0', true)],
    }),
  ]);

  await coordinator.startAll();

  expect(coordinator.getInfo('alternate')).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('duplicate-account-resolver'),
  });
  expect(journal.accountResolver()).toBe(accountResolver);

  expect(await coordinator.applyExtensionTransition('connector', false)).toBe('applied');
  expect(await coordinator.applyExtensionTransition('alternate', true)).toBe('applied');
  expect(journal.accountResolver()).toBe(alternate);
});

it('withdraws staged edges and the resolver when a later processor fails', async () => {
  let observed: unknown;
  let failActivation = true;
  coordinator.registerContributionProcessor({
    async processActivated() {
      if (!failActivation) return;
      observed = [
        journal.stagedEdgeFor('connector', edge.edge),
        journal.edgeFor('connector', edge.edge),
        journal.accountResolver(),
      ];
      throw new Error('Later contribution failed');
    },
  });
  coordinator.load([extension('connector', { namespaces: [namespace], edges: [edge], accountResolver })]);

  await coordinator.startAll();

  expect(observed).toEqual([edge, undefined, undefined]);
  expect(coordinator.getInfo('connector')).toMatchObject({ state: 'failed', error: 'Later contribution failed' });
  expect(journal.stagedEdgeFor('connector', edge.edge)).toBeUndefined();
  expect(journal.edgeFor('connector', edge.edge)).toBeUndefined();
  expect(journal.accountResolver()).toBeUndefined();

  failActivation = false;
  expect(await coordinator.applyExtensionTransition('connector', true)).toBe('applied');
  expect(journal.accountResolver()).toBe(accountResolver);
});

it('stages edges during create and exposes live contributions only until stop, including after re-enable', async () => {
  const observed: unknown[] = [];
  coordinator.load([
    extension('connector', {
      namespaces: [namespace],
      edges: [edge],
      accountResolver,
      create() {
        observed.push([
          journal.stagedEdgeFor('connector', edge.edge),
          journal.edgeFor('connector', edge.edge),
          journal.accountResolver(),
          journal.stagedEdgeFor('other', edge.edge),
        ]);
        return {};
      },
    }),
  ]);

  await coordinator.startAll();
  expect(journal.edgeFor('connector', edge.edge)).toEqual(edge);
  expect(journal.accountResolver()).toBe(accountResolver);

  expect(await coordinator.applyExtensionTransition('connector', false)).toBe('applied');
  expect(journal.stagedEdgeFor('connector', edge.edge)).toBeUndefined();
  expect(journal.edgeFor('connector', edge.edge)).toBeUndefined();
  expect(journal.accountResolver()).toBeUndefined();

  expect(await coordinator.applyExtensionTransition('connector', true)).toBe('applied');
  const duringCreate = [edge, undefined, undefined, undefined];
  expect(observed).toEqual([duringCreate, duringCreate]);
  expect(journal.edgeFor('connector', edge.edge)).toEqual(edge);
  expect(journal.accountResolver()).toBe(accountResolver);
});

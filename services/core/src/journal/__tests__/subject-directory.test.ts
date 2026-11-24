import { createBusInstance } from '@makaio/bus-core';
import { SubjectDirectorySubjects } from '@makaio/contracts';
import { createBusNamespace, journalSubject, localSubject, type SchemaRecord } from '@makaio/core';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { SubjectDirectory, SubjectActivationError } from '../index.js';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { constructContext } = useJournalHostFixture();

/**
 * Build a manifest for a directory test.
 * @param name - Extension name.
 * @param fields - Additional extension declarations.
 * @returns The manifest supplied to the coordinator.
 */
function extension(name: string, fields: Partial<KernelMakaioExtension> = {}): KernelMakaioExtension {
  return { name, displayName: name, version: '1.0.0', ...fields };
}

let bus: ReturnType<typeof createBusInstance>;
let coordinator: ExtensionCoordinator;
let directory: SubjectDirectory;
let canReadPreferences: boolean;

beforeEach(async () => {
  canReadPreferences = true;
  bus = createBusInstance();
  coordinator = new ExtensionCoordinator(bus, {
    loadEnabled() {
      if (!canReadPreferences) throw new Error('Preference store unavailable');
      return undefined;
    },
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
});

it('uses live state without reading enablement preferences', async () => {
  const namespace = createBusNamespace('sample', { changed: z.boolean() });
  coordinator.load([extension('example', { namespaces: [namespace] })]);
  await coordinator.startAll();
  canReadPreferences = false;

  expect((await list()).map(({ subject }) => subject)).toEqual(['sample.changed']);
});

it('keeps extensions without declarations independent of directory activation', async () => {
  const bareBus = createBusInstance();
  const bareCoordinator = new ExtensionCoordinator(bareBus);
  const bareDirectory = new SubjectDirectory(bareBus, bareCoordinator);
  try {
    await bareDirectory.init();
    bareCoordinator.load([extension('bare')]);
    await bareCoordinator.startAll();

    expect(bareCoordinator.getInfo('bare')?.state).toBe('active');
  } finally {
    await bareCoordinator.shutdown();
    await bareDirectory.destroy();
  }
});

afterEach(async () => {
  try {
    await coordinator.shutdown();
  } finally {
    await directory.destroy();
  }
});

/**
 * Query directory entries through the host bus.
 * @param pattern - Optional subscription pattern.
 * @returns The directory entries matched by the pattern.
 */
async function list(pattern?: string) {
  // ORIGIN: The directory query is made by the host on its own bus.
  return (await bus.request(bus.own('root'), SubjectDirectorySubjects.list, { pattern })).subjects;
}

it('projects every declaration and uses the bus subscription grammar', async () => {
  const namespace = createBusNamespace('sample', {
    'item.created': journalSubject(localSubject(z.string().describe('An item was created')), {
      retention: 'recorded',
      schemaVersion: '2',
      readOlder: { kind: 'upgrade', upgrade: (payload) => payload },
      retainPayload: { maxAgeMs: 5000 },
      suggestedFor: { send: ['makaio.host'], subscribe: ['makaio.extension'] },
    }),
    'item.progress': journalSubject(z.number(), { retention: 'volatile' }),
    'item.changed': z.boolean(),
    'item.get': journalSubject(
      { request: z.string().describe('Find an item'), response: z.number() },
      { suggestedFor: { send: ['makaio.extension'] } },
    ),
  });
  const child = createBusNamespace('sample:detail', { added: z.null() });
  const recorded = {
    subject: 'sample.item.created',
    extension: 'example',
    type: 'event',
    description: 'An item was created',
    schema: { type: 'string', description: 'An item was created' },
    retention: 'recorded',
    schemaVersion: '2',
    readOlder: 'upgrade',
    retainPayload: { maxAgeMs: 5000 },
    suggestedFor: { send: ['makaio.host'], subscribe: ['makaio.extension'] },
  };
  const subjects = [
    recorded,
    {
      subject: 'sample.item.progress',
      extension: 'example',
      type: 'event',
      description: 'sample.item.progress',
      schema: { type: 'number' },
      retention: 'volatile',
    },
    {
      subject: 'sample.item.changed',
      extension: 'example',
      type: 'event',
      description: 'sample.item.changed',
      schema: { type: 'boolean' },
    },
    {
      subject: 'sample.item.get',
      extension: 'example',
      type: 'request',
      description: 'Find an item',
      schema: { request: { type: 'string', description: 'Find an item' }, response: { type: 'number' } },
      suggestedFor: { send: ['makaio.extension'] },
    },
  ];
  const childSubject = {
    subject: 'sample:detail.added',
    extension: 'details',
    type: 'event',
    description: 'sample:detail.added',
    schema: { type: 'null' },
  };
  coordinator.load([extension('example', { namespaces: [namespace] }), extension('details', { namespaces: [child] })]);

  expect(await list()).toEqual([]);
  await coordinator.startAll();

  expect(await list()).toEqual([...subjects, childSubject]);
  expect(await list('sample.item.created')).toEqual([recorded]);
  expect(await list('sample.*')).toEqual(subjects);
  expect(await list('sample:*')).toEqual([childSubject]);
  expect(await list('missing.subject')).toEqual([]);
});

it('keeps unprojectable volatile events and marks only the affected halves of requests', async () => {
  const unsupported = z.date().describe('A date');
  const namespace = createBusNamespace('sample', {
    changed: unsupported,
    lookup: { request: unsupported, response: z.boolean() },
    fetch: { request: z.boolean(), response: unsupported },
  });
  coordinator.load([extension('example', { namespaces: [namespace] })]);

  await coordinator.startAll();

  const mark = { projectable: false, reason: expect.stringMatching(/date/i) };
  expect(coordinator.getInfo('example')?.state).toBe('active');
  expect(await list()).toEqual([
    { subject: 'sample.changed', extension: 'example', type: 'event', description: 'A date', schema: mark },
    {
      subject: 'sample.lookup',
      extension: 'example',
      type: 'request',
      description: 'A date',
      schema: { request: mark, response: { type: 'boolean' } },
    },
    {
      subject: 'sample.fetch',
      extension: 'example',
      type: 'request',
      description: 'A date',
      schema: { request: { type: 'boolean' }, response: mark },
    },
  ]);
});

it('projects accepted event and request values, and request response output', async () => {
  const optionalInput = z.object({ count: z.number().default(1) });
  const namespace = createBusNamespace('sample', {
    changed: journalSubject(
      z.string().transform((value) => value.length),
      { retention: 'recorded', schemaVersion: '1', readOlder: { kind: 'as-recorded' } },
    ),
    lookup: { request: optionalInput, response: optionalInput },
  });
  coordinator.load([extension('example', { critical: true, namespaces: [namespace] })]);

  await coordinator.startAll();

  expect(await list('sample.changed')).toMatchObject([{ schema: { type: 'string' } }]);
  expect(await list('sample.lookup')).toMatchObject([
    {
      schema: {
        request: { properties: { count: { type: 'number', default: 1 } } },
        response: { required: ['count'] },
      },
    },
  ]);
  expect(await list('sample.lookup')).not.toMatchObject([{ schema: { request: { required: ['count'] } } }]);
});

it('fails activation when a recorded schema cannot be projected', async () => {
  const namespace = createBusNamespace('sample', {
    changed: z.boolean(),
    recorded: journalSubject(z.date(), {
      retention: 'recorded',
      schemaVersion: '1',
      readOlder: { kind: 'as-recorded' },
    }),
  });
  coordinator.load([extension('example', { critical: true, namespaces: [namespace] })]);

  const start = coordinator.startAll();
  await expect(start).rejects.toBeInstanceOf(SubjectActivationError);
  await expect(start).rejects.toMatchObject({
    code: 'schema-not-projectable',
    extension: 'example',
    subject: 'sample.recorded',
  });
  expect(coordinator.getInfo('example')?.state).toBe('failed');
  expect(await list()).toEqual([]);
});

it.each(['schemaVersion', 'readOlder'])('names the missing recorded field %s', async (field) => {
  const options = { retention: 'recorded', schemaVersion: '1', readOlder: { kind: 'as-recorded' } } as const;
  // Model a malformed wrapper from a JavaScript extension.
  Reflect.deleteProperty(options, field);
  const namespace = createBusNamespace('sample', { recorded: journalSubject(z.boolean(), options) });
  coordinator.load([extension('example', { critical: true, namespaces: [namespace] })]);

  await expect(coordinator.startAll()).rejects.toMatchObject({
    code: 'schema-version-missing',
    subject: 'sample.recorded',
    message: expect.stringContaining(field),
  });
  expect(await list()).toEqual([]);
});

it('rejects a recorded request declared by a JavaScript extension', async () => {
  const options = {};
  Reflect.set(options, 'retention', 'recorded');
  const namespace = createBusNamespace('sample', {
    lookup: journalSubject({ request: z.boolean(), response: z.boolean() }, options),
  });
  coordinator.load([extension('example', { critical: true, namespaces: [namespace] })]);

  await expect(coordinator.startAll()).rejects.toMatchObject({
    code: 'retention-on-request',
    subject: 'sample.lookup',
  });
  expect(await list()).toEqual([]);
});

it('rejects a payload retention policy on a volatile event', async () => {
  const options = { retention: 'volatile' } as const;
  Reflect.set(options, 'retainPayload', 'keep');
  const namespace = createBusNamespace('sample', { changed: journalSubject(z.boolean(), options) });
  coordinator.load([extension('example', { critical: true, namespaces: [namespace] })]);

  await expect(coordinator.startAll()).rejects.toMatchObject({
    code: 'retain-on-volatile',
    subject: 'sample.changed',
  });
  expect(await list()).toEqual([]);
});

it('rejects duplicate declarations within an extension', async () => {
  const namespace = createBusNamespace('sample', { changed: z.boolean() });
  coordinator.load([extension('example', { critical: true, namespaces: [namespace, namespace] })]);

  await expect(coordinator.startAll()).rejects.toMatchObject({
    code: 'duplicate-subject',
    subject: 'sample.changed',
  });
  expect(await list()).toEqual([]);
});

it('rejects a duplicate canonical subject across distinct owned namespaces', async () => {
  const parent = createBusNamespace('sample:parent', { 'child.changed': z.boolean() });
  const child = createBusNamespace('sample:parent.child', { changed: z.boolean() });
  coordinator.load([
    extension('parent', { namespaces: [parent] }),
    extension('child', {
      critical: true,
      dependencies: [{ type: 'extension', name: 'parent', version: '*' }],
      namespaces: [child],
    }),
  ]);

  await expect(coordinator.startAll()).rejects.toMatchObject({
    code: 'duplicate-subject',
    subject: 'sample:parent.child.changed',
    extension: 'child',
  });
  expect(await list()).toMatchObject([{ subject: 'sample:parent.child.changed', extension: 'parent' }]);
});

it('does not let a list caller change the directory', async () => {
  const namespace = createBusNamespace('sample', { changed: z.boolean() });
  coordinator.load([extension('example', { namespaces: [namespace] })]);
  await coordinator.startAll();

  const subjects = await list();
  expect(subjects).toHaveLength(1);
  Object.assign(subjects[0] ?? {}, { description: 'changed by caller' });

  expect(await list()).toMatchObject([{ description: 'sample.changed' }]);
});

it('withdraws a stopped extension without withdrawing other active extensions', async () => {
  const sample = createBusNamespace('sample', { changed: z.boolean() });
  const other = createBusNamespace('other', { changed: z.boolean() });
  coordinator.load([extension('example', { namespaces: [sample] }), extension('other', { namespaces: [other] })]);
  await coordinator.startAll();
  expect(await list()).toHaveLength(2);

  expect(await coordinator.applyExtensionTransition('example', false)).toBe('applied');

  expect((await list()).map(({ subject }) => subject)).toEqual(['other.changed']);
});

it('does not publish declarations during a later processor or retain them after it fails', async () => {
  const schemas: SchemaRecord = { changed: z.boolean() };
  const namespace = createBusNamespace('sample', schemas);
  let failActivation = true;
  coordinator.registerContributionProcessor({
    async processActivated() {
      if (!failActivation) return;
      expect(await list()).toEqual([]);
      throw new Error('Later contribution failed');
    },
  });
  coordinator.load([extension('example', { namespaces: [namespace] })]);

  await coordinator.startAll();
  expect(coordinator.getInfo('example')).toMatchObject({ state: 'failed', error: 'Later contribution failed' });
  expect(directory.stagedSubjectFor('sample.changed')).toBeUndefined();
  expect(await list()).toEqual([]);

  // Retry the extension after its failed contribution stopped declaring a subject.
  Reflect.deleteProperty(schemas, 'changed');
  failActivation = false;
  expect(await coordinator.applyExtensionTransition('example', true)).toBe('applied');
  expect(await list()).toEqual([]);
});

it('does not list subjects from an extension that competes for a namespace', async () => {
  const owned = createBusNamespace('shared', { original: z.boolean() });
  const competing = createBusNamespace('shared', { extra: z.boolean() });
  coordinator.load([
    extension('owner', { namespaces: [owned] }),
    extension('contender', {
      dependencies: [{ type: 'extension', name: 'owner', version: '*' }],
      namespaces: [competing],
    }),
  ]);

  await coordinator.startAll();

  expect(coordinator.namespaceOwners().ownerOf('shared')).toEqual({ kind: 'extension', extension: 'owner' });
  expect(coordinator.getInfo('contender')).toMatchObject({
    state: 'failed',
    error: expect.stringMatching(/namespace-already-owned.*owner.*contender/),
  });
  expect((await list()).map(({ subject }) => subject)).toEqual(['shared.original']);
});

it('checks the owner even when a declaration is added after the coordinator claims namespaces', async () => {
  const owned = createBusNamespace('shared', { original: z.boolean() });
  const late = createBusNamespace('shared', { extra: z.boolean() });
  const namespaces: NonNullable<KernelMakaioExtension['namespaces']>[number][] = [];
  coordinator.load([
    extension('owner', { namespaces: [owned] }),
    extension('contender', {
      critical: true,
      dependencies: [{ type: 'extension', name: 'owner', version: '*' }],
      namespaces,
    }),
  ]);
  namespaces.push(late);

  await expect(coordinator.startAll()).rejects.toMatchObject({
    code: 'name-not-owned',
    subject: 'shared.extra',
    extension: 'contender',
  });
  expect((await list()).map(({ subject }) => subject)).toEqual(['shared.original']);
});

it('provides an independent exact declaration during create and publishes it once active', async () => {
  const namespace = createBusNamespace('sample', { changed: z.boolean() });
  const seen: unknown[] = [];
  coordinator.load([
    extension('example', {
      namespaces: [namespace],
      async create() {
        const staged = directory.stagedSubjectFor('sample.changed');
        seen.push(staged?.extension, directory.stagedSubjectFor('sample.*'), await list());
        if (staged) Reflect.set(staged, 'extension', 'other');
        return {};
      },
    }),
  ]);

  await coordinator.startAll();

  expect(seen).toEqual(['example', undefined, []]);
  expect(await list()).toMatchObject([{ subject: 'sample.changed', extension: 'example' }]);
});

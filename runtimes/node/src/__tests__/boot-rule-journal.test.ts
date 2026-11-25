import type { IHostMakaioBus } from '@makaio/bus-core';
import {
  defineReaction,
  type EntryRecordOutcome,
  type HostDatabase,
  type JournalEdgeCapability,
} from '@makaio/contracts';
import { JournalSubjects } from '@makaio/contracts/journal';
import type { RuleSourceContribution } from '@makaio/contracts/rules';
import { MAKAIO_RULES_PARTY_KIND } from '@makaio/core';
import { ExtensionSubjects, KernelSubjects, ServiceSkipError, type KernelMakaioExtension } from '@makaio/kernel';
import { busMessageTrigger } from '@makaio/services-core';
import { getHostDatabaseWake } from '@makaio/storage-drizzle';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { JOURNAL_ENTRIES_WAKE_TOPIC } from '../../../../services/core/src/journal/storage/append-entries.js';
import { JournalReaderStore } from '../../../../services/core/src/journal/storage/reader-store.js';
import { describeStorageConformance } from '../../../../storage/conformance/src/harness/env.js';
import { useSuiteDatabaseContext } from '../../../../storage/conformance/src/harness/suite-context.js';
import type { MakaioRuntime } from '../boot-types.js';
import { bootJournalHost, delivery, extension, subject, writer } from './boot-journal-fixture.js';

/**
 * @param beforeReaction - Optional barrier before recording a reaction.
 * @returns A live source and a declared reaction that records its execution.
 */
function ruleFixture(beforeReaction?: () => Promise<void>) {
  const effects: { value: string; digest: string }[] = [];
  const positions: number[] = [];
  let effect = Promise.withResolvers<void>();
  const reaction = defineReaction({
    kind: 'journal-rule-effects.record',
    description: 'Observe the source version and recorded value',
    parameterSchema: z.object({ value: z.string() }),
    keyed: true,
    async handler(call, { value }, { cause }) {
      await beforeReaction?.();
      expect(call.caller).toEqual({ id: MAKAIO_RULES_PARTY_KIND, kind: MAKAIO_RULES_PARTY_KIND });
      expect(call.principal.id).toBe(extension);
      effects.push({ value, digest: cause.ruleSet.digest });
      effect.resolve();
      effect = Promise.withResolvers<void>();
      return { state: 'accepted' };
    },
  });
  let digest = 'initial';
  let sourceError: Error | undefined;
  const ruleSource: RuleSourceContribution = {
    async rulesFor({ cause }) {
      if ('position' in cause.cause) positions.push(cause.cause.position);
      if (sourceError) throw sourceError;
      return {
        set: { id: 'rules', digest },
        groups: [],
        excluded: [],
        rules: [
          {
            id: 'record',
            description: 'Handle the recorded change',
            on: { kind: busMessageTrigger.kind, params: { subject } },
            reaction: { kind: reaction.kind, params: { value: { ref: '$event.facts.payload' } } },
          },
        ],
      };
    },
    ruleTriggers: () => [],
    onTriggersChanged: () => () => {},
  };
  const source: KernelMakaioExtension = {
    name: 'journal-rule-source',
    displayName: 'Journal rule source',
    version: '1.0.0',
    ruleSource,
  };
  const consumer: KernelMakaioExtension = {
    name: 'journal-rule-effects',
    displayName: 'Journal rule effects',
    version: '1.0.0',
    reactions: { createReactions: () => [reaction] },
  };
  return {
    source,
    consumer,
    effects,
    positions,
    nextEffect: () => effect.promise,
    /** @param count - Number of recorded reactions to wait for. */
    async waitForEffects(count: number): Promise<void> {
      while (effects.length < count) await effect.promise;
    },
    /** @param next - Digest of the source revision supplied to new entries. */
    setDigest(next: string) {
      digest = next;
    },
    failSource() {
      sourceError = new Error('Rule source is unavailable');
    },
  };
}

/**
 * Observe the durable retry after the registered source throws.
 * @param bus - Host bus serving the actual reader-state query.
 * @param database - Host transaction facade that publishes the settlement wake.
 * @param edge - Writer's entry point.
 * @param key - Delivery identifier.
 * @returns The accepted entry and its recorded identity.
 */
async function acceptWithThrowingSource(
  bus: Pick<IHostMakaioBus, 'own' | 'request'>,
  database: HostDatabase,
  edge: JournalEdgeCapability,
  key: string,
): Promise<EntryRecordOutcome> {
  const accepted = Promise.withResolvers<EntryRecordOutcome | undefined>();
  const retry = Promise.withResolvers<void>();
  const call = bus.own('observer');
  const unsubscribe = getHostDatabaseWake(database).subscribe(JOURNAL_ENTRIES_WAKE_TOPIC, async () => {
    try {
      const entry = await accepted.promise;
      if (!entry) return;
      const { states } = await bus.request(call, JournalSubjects['reader-states'], {
        reader: MAKAIO_RULES_PARTY_KIND,
        entryId: entry.entryId,
      });
      if (states[0]?.reason === 'rule-source-unavailable') {
        expect(states).toMatchObject([{ state: 'open', reason: 'rule-source-unavailable' }]);
        retry.resolve();
      }
    } catch (error) {
      retry.reject(error);
    }
  });
  try {
    const [entry] = await edge.accept(delivery(key));
    if (!entry) throw new Error('Expected a committed event.');
    accepted.resolve(entry);
    await retry.promise;
    return entry;
  } finally {
    unsubscribe();
    accepted.resolve(undefined);
  }
}

/**
 * Start a host, persist a delivery at the acceptance gate, and fail the remaining boot.
 * @returns The durable delivery and the home to reopen.
 */
async function bootInterruptedAfterDelivery() {
  const abort = new AbortController();
  const failure = new Error('boot cancelled after journal acceptance');
  const firstWriter = writer();
  const admissions = observeRuleAdmissions();
  const accepted = Promise.withResolvers<EntryRecordOutcome>();
  const first = await bootJournalHost([firstWriter.pkg], abort.signal, undefined, {
    configureCoordinator({ bus }) {
      return bus.on(KernelSubjects.phase.servicesReady, async () => {
        try {
          const edge = await firstWriter.started;
          const [entry] = await afterJournalWake(await firstWriter.database, () =>
            edge.accept(delivery('before-boot-failure')),
          );
          if (!entry) throw new Error('Expected a committed event.');
          expect(admissions()).toBe(0);
          await expect(ruleStates(bus)).resolves.toEqual({ readerPosition: 0, states: [] });
          accepted.resolve(entry);
        } catch (error) {
          accepted.reject(error);
        } finally {
          abort.abort(failure);
        }
      });
    },
  });
  void accepted.promise.catch(() => undefined);
  await expect(first.boot).rejects.toThrow(failure.message);
  const original = await accepted.promise;
  expect(original.status).toBe('recorded');
  return { home: first.home, entryId: original.entryId };
}

describe('after a late boot failure', () => {
  let restarted: {
    entryId: string;
    edge: Awaited<ReturnType<typeof writer>['started']>;
    effects: ReturnType<typeof ruleFixture>['effects'];
    applied: Promise<void>;
  };

  beforeEach(async () => {
    const first = await bootInterruptedAfterDelivery();
    const nextWriter = writer();
    const { source, consumer, effects, nextEffect } = ruleFixture();
    const applied = nextEffect();
    const { boot } = await bootJournalHost([nextWriter.pkg, source, consumer], undefined, undefined, {
      home: first.home,
    });
    await boot;
    restarted = { entryId: first.entryId, edge: await nextWriter.started, effects, applied };
  });

  it('recovers the accepted entry exactly once', async () => {
    const { edge, effects, entryId, applied } = restarted;
    await expect(edge.accept(delivery('before-boot-failure'))).resolves.toEqual([{ status: 'known', entryId }]);
    await applied;
    expect(effects).toEqual([{ value: 'before-boot-failure', digest: 'initial' }]);
  });
});

/** @param bus - Host bus that can inspect the durable reader progress.
 * @returns The built-in reader's stored position and paged entry states.
 */
function ruleStates(bus: Pick<IHostMakaioBus, 'own' | 'request'>) {
  return bus.request(bus.own('observer'), JournalSubjects['reader-states'], { reader: MAKAIO_RULES_PARTY_KIND });
}

/** @param edge - Journal ingress.
 * @param keys - Entries to record in one order partition, in delivery order.
 */
async function recordOrdered(edge: JournalEdgeCapability, keys: readonly string[]) {
  const outcomes = await edge.accept({
    entries: keys.map((key) => ({ key, subject, payload: key, orderKey: 'ordered' })),
  });
  expect(outcomes.map(({ status }) => status)).toEqual(keys.map(() => 'recorded'));
}

/** @returns A count of calls that reached real rule reader admission. */
function observeRuleAdmissions(): () => number {
  const admit = vi.spyOn(JournalReaderStore.prototype, 'admit');
  onTestFinished(() => {
    admit.mockRestore();
  });
  return () => admit.mock.calls.filter(([reader]) => reader === MAKAIO_RULES_PARTY_KIND).length;
}

/**
 * Wait for the commit wake, which invokes the already-subscribed reader before this observer.
 * @param database - Host that publishes the wake.
 * @param write - Operation that commits journal entries.
 * @param notifications - Include the PostgreSQL LISTEN echo when draining wakes before activation.
 * @returns The write result, after the wake reaches the reader.
 */
async function afterJournalWake<T>(database: HostDatabase, write: () => Promise<T>, notifications = 1): Promise<T> {
  const wake = getHostDatabaseWake(database);
  await wake.ready();
  const delivered = Promise.withResolvers<void>();
  const unsubscribe = wake.subscribe(JOURNAL_ENTRIES_WAKE_TOPIC, () => {
    if (--notifications === 0) delivered.resolve();
  });
  try {
    const result = await write();
    await delivered.promise;
    return result;
  } finally {
    unsubscribe();
  }
}

describeStorageConformance('rule source lifecycle', (config) => {
  const context = useSuiteDatabaseContext(config);
  let fixture: ReturnType<typeof ruleFixture>;
  let host: MakaioRuntime;
  let edge: JournalEdgeCapability;
  let database: HostDatabase;
  let releaseEffects: () => void;
  let admissions: () => number;
  let blockedActivations: number;

  beforeEach(async () => {
    const effects = Promise.withResolvers<void>();
    releaseEffects = () => effects.resolve();
    admissions = observeRuleAdmissions();
    blockedActivations = 0;
    fixture = ruleFixture(() => effects.promise);
    const { pkg, started, database: readyDatabase } = writer();
    let ready = false;
    const source: KernelMakaioExtension = {
      ...fixture.source,
      create: () => ({
        init: async () => {
          if (!ready) throw new ServiceSkipError('The source is waiting for configuration');
        },
      }),
    };
    const { boot } = await bootJournalHost([pkg, source, fixture.consumer], undefined, undefined, {
      database: { url: context().url },
      configureCoordinator({ bus }) {
        return bus.intercept(ExtensionSubjects.stateChanged, (ctx) => {
          if (ctx.payload.name !== source.name || ctx.payload.to !== 'active') return;
          blockedActivations++;
          ctx.stopPropagation();
        });
      },
    });
    host = await boot;
    onTestFinished(releaseEffects);
    ready = true;
    edge = await started;
    database = await readyDatabase;
  });

  it('continues when a source returns and reads the updated source on the next entry', async () => {
    const { source, consumer, effects, positions, setDigest, failSource, waitForEffects } = fixture;
    expect(host.coordinator.getRuleSource()).toBeUndefined();
    await afterJournalWake(
      database,
      () => recordOrdered(edge, ['before-source-a', 'before-source-b', 'initial-source']),
      config.name === 'postgres' ? 2 : 1,
    );
    expect(admissions()).toBe(0);
    expect(await ruleStates(host.bus)).toEqual({ readerPosition: 0, states: [] });
    expect(positions).toEqual([]);
    expect(effects).toEqual([]);

    const initial = waitForRuleStates(host.bus, database, 3);
    await expect(host.coordinator.applyExtensionTransition(source.name, true)).resolves.toBe('applied');
    expect(host.coordinator.getRuleSource()).toBe(source.ruleSource);
    expect(host.coordinator.getInfo(consumer.name)?.state).toBe('active');
    await initial;
    expect(blockedActivations).toBe(1);
    expect((await ruleStates(host.bus)).states.map(({ retries }) => retries)).toEqual([0, 0, 0]);
    expect(positions).toEqual([1, 2, 3]);

    await expect(host.coordinator.applyExtensionTransition(source.name, false)).resolves.toBe('applied');
    const beforePause = admissions();
    await afterJournalWake(database, () => recordOrdered(edge, ['waiting-for-source', 'also-waiting']));
    expect(admissions()).toBe(beforePause);
    const paused = await ruleStates(host.bus);
    expect(paused.readerPosition).toBe(3);
    expect(paused.states.map(({ state }) => state)).toEqual(['done', 'done', 'done']);
    expect(positions).toEqual([1, 2, 3]);
    releaseEffects();
    await waitForEffects(3);
    expect(host.coordinator.getRuleSource()).toBeUndefined();

    const updated = waitForRuleStates(host.bus, database, 5);
    setDigest('updated');
    await expect(host.coordinator.applyExtensionTransition(source.name, true)).resolves.toBe('applied');
    await updated;
    await waitForEffects(5);
    expect(positions).toEqual([1, 2, 3, 4, 5]);
    failSource();
    await acceptWithThrowingSource(host.bus, database, edge, 'source-threw');
    expect(effects).toEqual([
      { value: 'before-source-a', digest: 'initial' },
      { value: 'before-source-b', digest: 'initial' },
      { value: 'initial-source', digest: 'initial' },
      { value: 'waiting-for-source', digest: 'updated' },
      { value: 'also-waiting', digest: 'updated' },
    ]);
  });
});

/**
 * Observe committed completion via journal wakes.
 * @param bus - Host bus serving the reader-state query.
 * @param database - Host database publishing commit notifications.
 * @param count - Number of completed states to wait for.
 * @returns Completion when the requested states are durable.
 */
function waitForRuleStates(bus: Pick<IHostMakaioBus, 'own' | 'request'>, database: HostDatabase, count: number) {
  const done = Promise.withResolvers<void>();
  const unsubscribe = getHostDatabaseWake(database).subscribe(JOURNAL_ENTRIES_WAKE_TOPIC, async () => {
    try {
      const { states } = await ruleStates(bus);
      if (states.filter(({ state }) => state === 'done').length === count) done.resolve();
    } catch (error) {
      done.reject(error);
    }
  });
  onTestFinished(unsubscribe);
  return done.promise.finally(unsubscribe);
}

describeStorageConformance('restarting the rule reader without a source', (config) => {
  const context = useSuiteDatabaseContext(config);
  let host: MakaioRuntime;
  let edge: JournalEdgeCapability;
  let database: HostDatabase;
  let admissions: () => number;

  beforeEach(async () => {
    const first = writer();
    const { source, consumer } = ruleFixture();
    const target = { url: context().url };
    const started = await bootJournalHost([first.pkg, source, consumer], undefined, undefined, { database: target });
    const running = await started.boot;
    const completed = waitForRuleStates(running.bus, await first.database, 1);
    await recordOrdered(await first.started, ['already-processed']);
    await completed;
    await running.shutdown();
    const next = writer();
    admissions = observeRuleAdmissions();
    const restarted = await bootJournalHost([next.pkg], undefined, undefined, { database: target, home: started.home });
    host = await restarted.boot;
    edge = await next.started;
    database = await next.database;
  });

  it('leaves the saved position and existing states intact', async () => {
    expect(host.coordinator.getRuleSource()).toBeUndefined();
    const before = await ruleStates(host.bus);
    expect(before.readerPosition).toBe(1);
    expect(before.states).toMatchObject([{ state: 'done' }]);
    await afterJournalWake(database, () => recordOrdered(edge, ['after-restart-a', 'after-restart-b']));
    expect(admissions()).toBe(0);
    const entries = await host.bus.request(host.bus.own('observer'), JournalSubjects.entries, {});
    expect(entries.entries).toHaveLength(3);
    expect(await ruleStates(host.bus)).toEqual(before);
  });
});

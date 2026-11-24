import { AccessSubjects, CoreDenialPlace, type AccessDenied } from '@makaio/contracts/access';
import { JOURNAL_PAGE_MAX_LIMIT, JournalSubjects } from '@makaio/contracts/journal';
import {
  SUBJECT_SUBSCRIBE_RIGHT,
  SubjectSubscribeRightContextSchema,
  type RightsSourceContribution,
} from '@makaio/contracts/rights';
import type { CallContext } from '@makaio/core';
import type { KernelMakaioExtension } from '@makaio/kernel';
import { expect, it, onTestFinished, vi } from 'vitest';
import { bootJournalHost, delivery, extension, subject, writer } from './boot-journal-fixture.js';

const consumer = 'journal-boot-reader';
const reader = `${consumer}.changes`;
const denied = 'hidden-entry';
const sourceError = 'source-error-entry';

const source: RightsSourceContribution = {
  source: `${extension}.read-policy`,
  description: 'Deny a recorded value for a subscription.',
  rights: [SUBJECT_SUBSCRIBE_RIGHT],
  async answer({ context }) {
    const question = SubjectSubscribeRightContextSchema.parse(context);
    if (question.payload === sourceError) throw new Error(sourceError);
    if (question.subject === subject && question.payload === denied)
      return { granted: false, reason: `Denied value: ${denied}` };
    return { granted: true };
  },
};

it('checks recorded payloads when reading locally and continues from the cursor', async () => {
  const { pkg, started } = writer();
  const { boot } = await bootJournalHost([{ ...pkg, rightsSources: [source] }]);
  const { bus } = await boot;
  const denials: AccessDenied[] = [];
  onTestFinished(bus.on(AccessSubjects.denied, ({ payload }) => void denials.push(payload)));

  const edge = await started;
  const rows = await edge.accept({
    entries: ['first', 'second', denied, sourceError].flatMap((key) => delivery(key).entries),
  });
  expect(rows.map(({ status }) => status)).toEqual(['recorded', 'recorded', 'recorded', 'recorded']);
  // ORIGIN: The host operator initiates a journal query.
  const call = bus.own('observer');
  const page = await bus.request(call, JournalSubjects.entries, { subject, limit: 1 });
  expect(page.entries.map(({ key }) => key)).toEqual(['first']);
  expect(typeof page.nextCursor).toBe('string');
  const remaining = await bus.request(call, JournalSubjects.entries, {
    subject,
    cursor: page.nextCursor,
    from: Number.MAX_SAFE_INTEGER,
  });
  expect(remaining).toMatchObject({ entries: [{ key: 'second' }] });
  expect(remaining.nextCursor).toBeUndefined();
  const hidden = rows[2];
  if (hidden === undefined) throw new Error('The edge did not return the denied entry.');
  await expect(bus.request(call, JournalSubjects.entries, { entryId: hidden.entryId })).resolves.toEqual({
    entries: [],
  });
  await expect(bus.request(call, JournalSubjects.entries, { limit: JOURNAL_PAGE_MAX_LIMIT + 1 })).rejects.toThrow();
  await vi.waitFor(() =>
    expect(denials).toContainEqual(
      expect.objectContaining({
        at: CoreDenialPlace.read,
        subject,
        right: SUBJECT_SUBSCRIBE_RIGHT,
        reason: 'access-denied',
      }),
    ),
  );
  expect(denials).toHaveLength(3);
  expect(JSON.stringify(denials)).not.toContain(denied);
  expect(JSON.stringify(denials)).not.toContain(sourceError);
});

it('uses the reader identity for authorization and keeps denied entries out of the handler', async () => {
  const calls: CallContext[] = [];
  const keys: string[] = [];
  const questions: Parameters<RightsSourceContribution['answer']>[0][] = [];
  const { pkg, started } = writer();
  const readerPackage: KernelMakaioExtension = {
    name: consumer,
    displayName: 'Journal reader',
    version: '1.0.0',
    critical: true,
    create: () => ({ init: async () => {}, destroy: () => {} }),
    readers: [
      {
        reader,
        description: 'Read changes from the beginning.',
        startAt: 'beginning',
        subjects: () => [subject],
        async handle(call, entry) {
          calls.push(call);
          keys.push(entry.key);
          return { state: 'done' };
        },
      },
    ],
  };
  const { boot } = await bootJournalHost([
    readerPackage,
    {
      ...pkg,
      rightsSources: [
        {
          ...source,
          async answer(question) {
            questions.push(question);
            return source.answer(question);
          },
        },
      ],
    },
  ]);
  const { bus } = await boot;
  const edge = await started;
  const rows = await edge.accept({ entries: [denied, 'visible'].flatMap((key) => delivery(key).entries) });
  // ORIGIN: The host operator inspects the reader's durable state.
  const call = bus.own('observer');
  await vi.waitFor(async () => {
    const { states } = await bus.request(call, JournalSubjects['reader-states'], { reader });
    expect(states.map(({ entryId, state }) => ({ entryId, state }))).toEqual(
      rows.map(({ entryId }) => ({ entryId, state: 'done' })),
    );
  });
  const caller = { kind: 'makaio.extension', id: consumer };
  expect(questions).toContainEqual(
    expect.objectContaining({
      call: { caller, principal: caller },
      context: { subject, payload: denied },
      right: SUBJECT_SUBSCRIBE_RIGHT,
    }),
  );
  expect(keys).toEqual(['visible']);
  expect(calls).toMatchObject([{ caller, principal: { kind: 'makaio.extension', id: extension } }]);
});

import { defineReaction, type Condition } from '@makaio/contracts';
import type { ReactionRule } from '@makaio/contracts/rules';
import { RuleEvaluator } from '@makaio/services-core';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { contributions, enqueue, occasion, principal, read, ruleFor, witness } from './rules-evaluation-support.js';

describeStorageConformance('rule evaluation', (config) => {
  const context = useSuiteDatabaseContext(config);

  it('reports an unavailable source when reading its reply throws', async () => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    const registration = {
      contribution: {
        async rulesFor() {
          return {
            get set(): never {
              throw new Error('Rule set could not be read');
            },
          };
        },
        ruleTriggers: () => [],
        onTriggersChanged: () => () => {},
      },
    };
    const evaluator = new RuleEvaluator(db, service, invoke, () => registration);
    await expect(evaluator.prepare(occasion([ruleFor()]))).resolves.toEqual({ state: 'source-unavailable' });
  });

  it('commits decisions, resolved each inputs and a start marker before a single invocation per part', async () => {
    const db = createHostDatabase(context().db);
    const sibling = config.dialect === 'postgres' ? await context().createSiblingClient() : undefined;
    const independent = sibling ? createHostDatabase(sibling.db) : db;
    const seen = new Map<string, string>();
    const input = occasion([
      ruleFor({
        each: '$event.facts.payload.entries',
        reaction: { kind: 'rule-suite.notify', params: { value: { ref: '$item' } } },
      }),
    ]);
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Observe persisted data before the effect',
        parameterSchema: z.object({ value: z.string() }),
        keyed: true,
        async handler(call, { value }, execution) {
          const committed = await read(independent, input.id);
          expect(committed.cause?.groups[0]).toMatchObject({ state: 'decided', acting: ['notify'] });
          expect(committed.parts).toHaveLength(2);
          expect(committed.parts.find((part) => part.key === execution.key)).toMatchObject({
            parameters: { value },
            callStartedAt: expect.any(Number),
            attempt: 1,
          });
          expect(call).toMatchObject({ caller: { id: 'makaio.rules' }, principal, attestedBy: witness });
          expect(execution.cause).toMatchObject({ ruleSet: input.snapshot.set, ruleId: 'notify' });
          expect(seen.has(execution.key)).toBe(false);
          seen.set(execution.key, value);
          return { state: 'accepted' };
        },
      }),
    );
    try {
      await expect(enqueue(db, service, invoke, input)).resolves.toBe(true);
      await expect(enqueue(independent, service, invoke, input)).resolves.toBe(false);
      await Promise.all([
        new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id),
        new RuleEvaluator(independent, service, invoke, () => undefined).evaluate(input.id),
      ]);
      expect([...seen.values()].sort()).toEqual(['first', 'second']);
      expect((await read(db, input.id)).rules[0]?.state).toBe('accepted');
    } finally {
      await sibling?.close();
    }
  });

  it.each([
    {
      label: 'inactive trigger',
      rules: [ruleFor({ on: { kind: 'rule-suite.inactive' } })],
      reason: 'trigger-unavailable',
      blocked: ['notify'],
      accepted: [],
    },
    {
      label: 'duplicate identifier',
      rules: [ruleFor(), ruleFor({ description: 'A competing definition' }), ruleFor({ id: 'valid' })],
      reason: 'duplicate-rule-id',
      blocked: ['notify', 'notify'],
      accepted: ['valid'],
    },
    {
      label: 'malformed rule and two valid rules',
      rules: [Object.assign(ruleFor(), { reaction: null }), ruleFor({ id: 'first' }), ruleFor({ id: 'second' })],
      reason: 'rule-invalid',
      blocked: ['notify'],
      accepted: ['first', 'second'],
    },
  ])('commits the occasion with $label', async ({ rules, reason, blocked, accepted }) => {
    const db = createHostDatabase(context().db);
    const invoked: string[] = [];
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Observe the effects of usable rules',
        parameterSchema: z.object({}),
        keyed: false,
        async handler(_call, _params, { cause }) {
          invoked.push(cause.ruleId);
          return { state: 'accepted' };
        },
      }),
    );
    const input = occasion(rules);
    await expect(enqueue(db, service, invoke, input)).resolves.toBe(true);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    const stored = await read(db, input.id);
    expect(stored.cause).toMatchObject({ state: 'decided', snapshot: { snapshot: { set: input.snapshot.set } } });
    const blockedRows = stored.rules.filter((rule) => rule.state === 'failed' && rule.reason === reason);
    expect(blockedRows.map(({ ruleId }) => ruleId).sort()).toEqual(blocked);
    expect(blockedRows.map(({ snapshot }) => snapshot)).toEqual(
      expect.arrayContaining(blocked.map((ruleId, sourceIndex) => ({ ruleId, sourceIndex, reason }))),
    );
    expect(
      stored.rules
        .filter((rule) => rule.state === 'accepted')
        .map((rule) => rule.ruleId)
        .sort(),
    ).toEqual(accepted);
    expect(invoked.sort()).toEqual(accepted);
  });

  it.each([true, false])('persists a known outcome after shutdown (before handler: %s)', async (beforeHandler) => {
    const db = createHostDatabase(context().db);
    const stopping = new AbortController();
    const calls: string[] = [];
    let dispatching = false;
    const input = occasion([ruleFor()]);
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Cancel before handler entry or let a running handler finish',
        parameterSchema: z.object({}).superRefine(() => {
          if (beforeHandler && dispatching) stopping.abort(new Error('host shutdown'));
        }),
        keyed: false,
        async handler(_call, _parameters, { key }) {
          calls.push(key);
          stopping.abort(new Error('host shutdown'));
          return { state: 'accepted', result: 'finished' };
        },
      }),
    );
    await enqueue(db, service, invoke, input);
    const evaluator = new RuleEvaluator(
      db,
      service,
      (...args) => {
        dispatching = true;
        return invoke(...args);
      },
      () => undefined,
    );
    await evaluator.evaluate(input.id, stopping.signal);
    expect(calls).toHaveLength(beforeHandler ? 0 : 1);
    expect((await read(db, input.id)).parts[0]).toMatchObject(
      beforeHandler
        ? { state: 'pending', reason: expect.stringContaining('cancelled before handler entry'), callDeadline: null }
        : { state: 'accepted', result: { value: 'finished' }, callDeadline: null },
    );
  });

  it('retries an unkeyed part when parameter validation outlives the invocation deadline', async () => {
    const db = createHostDatabase(context().db);
    const validation = Promise.withResolvers<void>();
    const keys: string[] = [];
    let dispatching = false;
    const input = occasion([ruleFor()]);
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Await parameter validation before running an unkeyed effect',
        parameterSchema: z.object({}).superRefine(async () => {
          if (dispatching) await validation.promise;
        }),
        keyed: false,
        async handler(_call, _parameters, { key }) {
          keys.push(key);
          return { state: 'accepted' };
        },
      }),
    );
    await enqueue(db, service, invoke, input);
    const evaluator = new RuleEvaluator(
      db,
      service,
      (...args) => {
        dispatching = true;
        return invoke(...args);
      },
      () => undefined,
      250,
    );
    try {
      await evaluator.evaluate(input.id);
      expect(keys).toEqual([]);
      const first = (await read(db, input.id)).parts[0];
      expect(first).toMatchObject({
        state: 'pending',
        attempt: 1,
        reason: expect.stringContaining('cancelled before handler entry'),
        callDeadline: null,
        notBefore: expect.any(Number),
      });

      validation.resolve();
      const retry = new RuleEvaluator(db, service, invoke, () => undefined);
      await delay(Math.max(0, (first?.notBefore ?? 0) - Date.now() + 1));
      await retry.evaluate(input.id);
      await retry.evaluate(input.id);
      expect(keys).toEqual([first?.key]);
      expect((await read(db, input.id)).parts[0]).toMatchObject({ state: 'accepted', attempt: 2 });
    } finally {
      validation.resolve();
    }
  });

  it.each([
    { keyed: true, returnsInvalidOutcome: false },
    { keyed: false, returnsInvalidOutcome: false },
    { keyed: true, returnsInvalidOutcome: true },
    { keyed: false, returnsInvalidOutcome: true },
  ])('recovers an interrupted reaction (keyed: $keyed, invalid return: $returnsInvalidOutcome)', async (testCase) => {
    const { keyed, returnsInvalidOutcome } = testCase;
    const db = createHostDatabase(context().db);
    const stopping = new AbortController();
    const keys: string[] = [];
    const input = occasion([ruleFor()]);
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Lose the first handler outcome after effect start',
        parameterSchema: z.object({}),
        keyed,
        async handler(_call, _parameters, { key }) {
          keys.push(key);
          if (keys.length === 1) {
            stopping.abort(new Error('host shutdown'));
            if (returnsInvalidOutcome) return undefined as never;
            throw stopping.signal.reason;
          }
          return { state: 'accepted' };
        },
      }),
    );
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined, 500).evaluate(input.id, stopping.signal);
    const first = (await read(db, input.id)).parts[0];
    if (!keyed) {
      expect(first).toMatchObject({
        state: 'failed',
        key: keys[0],
        code: 'outcome-unknown',
        result: null,
        callDeadline: null,
      });
      const restarted = new RuleEvaluator(createHostDatabase(context().db), service, invoke, () => undefined);
      await restarted.evaluate(input.id);
      expect(keys).toHaveLength(1);
      expect((await read(db, input.id)).parts[0]).toEqual(first);
      return;
    }
    expect(first).toMatchObject({
      state: 'pending',
      key: keys[0],
      reason: 'host shutdown',
      result: null,
      notBefore: expect.any(Number),
      callDeadline: null,
    });
    const restarted = new RuleEvaluator(createHostDatabase(context().db), service, invoke, () => undefined, 500);
    await delay(Math.max(0, (first?.notBefore ?? 0) - Date.now() + 1));
    await restarted.evaluate(input.id);
    expect(keys).toEqual([first?.key, first?.key]);
    expect((await read(db, input.id)).parts[0]?.state).toBe('accepted');
  });

  it.each([
    { keyed: false, invalidOutcome: undefined },
    { keyed: true, invalidOutcome: { state: 'unknown' } },
  ])('persists a terminal handler failure for an invalid outcome (keyed: $keyed)', async ({
    keyed,
    invalidOutcome,
  }) => {
    const db = createHostDatabase(context().db);
    const input = occasion([ruleFor()]);
    let calls = 0;
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Return an invalid outcome',
        parameterSchema: z.object({}),
        keyed,
        async handler() {
          calls++;
          return invalidOutcome as never;
        },
      }),
    );
    await enqueue(db, service, invoke, input);
    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    await evaluator.evaluate(input.id);
    await evaluator.evaluate(input.id);
    const stored = await read(db, input.id);
    expect(stored.rules[0]?.state).toBe('failed');
    expect(stored.parts).toEqual([
      expect.objectContaining({
        state: 'failed',
        code: 'handler-failed',
        reason: expect.any(String),
        result: null,
        attempt: 1,
        notBefore: null,
        callDeadline: null,
      }),
    ]);
    expect(calls).toBe(1);
  });

  it('leaves unsupported multi-member groups pending', async () => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    const unsupported = occasion([
      ruleFor({ group: 'alerts', priority: 10 }),
      ruleFor({ id: 'fallback', group: 'alerts', priority: 0 }),
    ]);
    const input = {
      ...unsupported,
      snapshot: { ...unsupported.snapshot, groups: [{ group: 'alerts', strategy: 'makaio.all' }] },
    };
    await enqueue(db, service, invoke, input);
    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    await evaluator.evaluate(input.id);
    expect((await read(db, input.id)).cause?.groups[0]).toMatchObject({
      state: 'pending',
      reason: 'not-implemented',
      members: [
        { ruleId: 'notify', priority: 10 },
        { ruleId: 'fallback', priority: 0 },
      ],
    });
  });

  it('records a condition error and treats a missing lookup as a mismatch', async () => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    service.lookups.register('rule-suite', [
      {
        kind: 'rule-suite.find',
        description: 'Lookup may return no value',
        args: z.object({}),
        answer: () => ({}),
        async resolve(call) {
          expect(call).toMatchObject({ principal, attestedBy: witness });
          return null;
        },
      },
    ]);
    const input = occasion([
      ruleFor({ when: { $expr: 'unknownFunction()' } }),
      ruleFor({ id: 'missing', lookups: [{ lookup: 'rule-suite.find', name: 'record', args: {} }] }),
    ]);
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    expect(await read(db, input.id)).toMatchObject({
      rules: expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'notify',
          state: 'failed',
          reason: 'condition-error',
          conditionPath: expect.any(String),
        }),
        expect.objectContaining({ ruleId: 'missing', state: 'not-matched' }),
      ]),
      parts: [],
    });
  });
  it.each(['ref', 'template', 'literal'])('treats the single lookup argument %s as a record key', async (name) => {
    const db = createHostDatabase(context().db);
    const argsSeen: unknown[] = [];
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Accept the rule after the lookup',
        parameterSchema: z.object({}),
        keyed: false,
        handler: async () => ({ state: 'accepted' }),
      }),
    );
    service.lookups.register('rule-suite', [
      {
        kind: 'rule-suite.named',
        description: 'Accept one named parameter',
        args: z.strictObject({ [name]: z.literal('fixed') }),
        answer: () => ({ type: 'boolean' }),
        async resolve(_call, args) {
          argsSeen.push(args);
          return true;
        },
      },
    ]);
    const args = { [name]: 'fixed' };
    const rule = ruleFor({ lookups: [{ lookup: 'rule-suite.named', name: 'named', args }] });
    const rights = { listRights: () => [], canSubscribe: async () => true, canSend: async () => true };
    const findings = await service.validate(rights, { rules: [rule], groups: [] });
    expect(findings.filter(({ severity }) => severity === 'error')).toEqual([]);
    const input = occasion([rule]);
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    expect(argsSeen).toEqual([args]);
    expect((await read(db, input.id)).rules).toMatchObject([{ state: 'accepted' }]);
  });

  it('binds earlier lookup values, applies the full where filter and accepts an empty each', async () => {
    const db = createHostDatabase(context().db);
    const seen: string[] = [];
    const filters: Array<Condition | undefined> = [];
    const ref = { ref: '$lookup.limit' };
    const markers = { refShape: ref, literalShape: { literal: 'fixed' } };
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Record each filtered value',
        parameterSchema: z.object({ value: z.string() }),
        keyed: false,
        async handler(_call, { value }) {
          seen.push(value);
          return { state: 'accepted', result: null };
        },
      }),
    );
    service.lookups.register('rule-suite', [
      {
        kind: 'rule-suite.limit',
        description: 'Resolve a bound',
        args: z.object({}),
        answer: () => ({ type: 'number' }),
        async resolve() {
          return 2;
        },
      },
      {
        kind: 'rule-suite.rows',
        description: 'Resolve candidate rows',
        args: z.object({ minimum: z.number() }),
        answer: () => ({ type: 'array' }),
        where: {
          roots: () => ({
            level: { type: 'number' },
            label: { type: 'string' },
            refShape: { type: 'object' },
            literalShape: { type: 'object' },
          }),
        },
        async resolve(_call, args, where) {
          expect(args.minimum).toBe(2);
          filters.push(where);
          return [
            { ...markers, level: 1, label: 'excluded' },
            { ...markers, level: 3, label: 'included' },
          ];
        },
      },
    ]);
    const lookup = {
      lookup: 'rule-suite.rows',
      name: 'rows',
      args: { minimum: ref },
    };
    const limit = { lookup: 'rule-suite.limit', name: 'limit', args: {} };
    const filtered = ruleFor({
      lookups: [
        limit,
        {
          ...lookup,
          where: {
            $and: [
              { field: 'level', operator: { $gt: ref } },
              { field: 'refShape', operator: { $eq: { literal: markers.refShape } } },
              { field: 'literalShape', operator: { $eq: { literal: markers.literalShape } } },
              { field: 'label', operator: { $startsWith: { literal: 'included' } } },
              { field: 'level', operator: { $lte: 3 } },
              { $expr: 'true' },
            ],
          },
        },
      ],
      each: '$lookup.rows',
      reaction: { kind: 'rule-suite.notify', params: { value: { ref: '$item.label' } } },
    });
    const empty = { ...filtered, id: 'empty', lookups: [limit, { ...lookup, where: { $expr: 'false' } }] };
    const invalid: ReactionRule = {
      ...filtered,
      id: 'invalid',
      lookups: [limit, { ...lookup, where: { field: 'label', operator: { $startsWith: ref } } }],
    };
    const rights = { listRights: () => [], canSubscribe: async () => true, canSend: async () => true };
    const findings = await service.validate(rights, { rules: [filtered, invalid], groups: [] });
    expect(findings.filter(({ severity }) => severity === 'error')).toMatchObject([
      { ruleId: 'invalid', code: 'params-invalid', path: 'lookups.1.where' },
    ]);
    const input = occasion([filtered, empty, invalid]);
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    expect(filters).toEqual([
      {
        $and: [
          { field: 'level', operator: { $gt: 2 } },
          { field: 'refShape', operator: { $eq: markers.refShape } },
          { field: 'literalShape', operator: { $eq: markers.literalShape } },
          { field: 'label', operator: { $startsWith: 'included' } },
          { field: 'level', operator: { $lte: 3 } },
        ],
      },
      undefined,
    ]);
    expect(seen).toEqual(['included']);
    const stored = await read(db, input.id);
    expect(Object.fromEntries(stored.rules.map(({ ruleId, state }) => [ruleId, state]))).toEqual({
      notify: 'accepted',
      empty: 'accepted',
      invalid: 'not-matched',
    });
    expect(stored.parts).toMatchObject([{ state: 'accepted', result: { value: null } }]);
  });
});

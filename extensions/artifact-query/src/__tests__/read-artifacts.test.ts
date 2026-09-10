import { describe, expect, it } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import {
  ArtifactKindRegistrationSchema,
  ArtifactRevisionSchema,
  type ArtifactKindRegistration,
  type ArtifactRef,
  type ArtifactRevision,
} from '@makaio/contracts';
import type { ToolExecutionContext } from '@makaio/tools-core';
import { executeReadArtifacts, type ArtifactReadHost } from '../read-artifacts.js';
import { artifactQueryPackage, createArtifactQueryPackage } from '../index.js';
import { ReadArtifactsInputSchema } from '../schemas.js';
import type { ReadArtifactsInput } from '../schemas.js';

const kind = ArtifactKindRegistrationSchema.parse({
  kind: 'decision',
  description: 'A decision used by selected-read tests.',
  schemaVersion: 1,
  category: 'commitment',
  titlePath: 'subject',
  dataSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      statement: { type: 'string' },
      publishedAt: { type: 'string', format: 'date-time' },
      details: {
        type: 'object',
        properties: {
          rationale: { type: 'string' },
          examples: { type: 'array', items: { type: 'string' } },
          optionalNote: { type: 'string' },
        },
        required: ['rationale'],
      },
    },
    required: ['subject', 'statement'],
  },
  views: { compact: { fields: ['subject', 'statement'] } },
});

function artifact(
  id: string,
  revision: string,
  data: Record<string, unknown>,
  options: { readonly kind?: string; readonly schemaVersion?: number } = {},
): ArtifactRevision {
  return ArtifactRevisionSchema.parse({
    kind: options.kind ?? 'decision',
    id,
    revision,
    schemaVersion: options.schemaVersion ?? 1,
    scope: { level: 'global' },
    data,
    relations: [],
    actor: { kind: 'agent', id: 'test' },
    timestamp: 0,
  });
}

function host(
  registrations: readonly ArtifactKindRegistration[],
  current: readonly ArtifactRevision[],
  pinned: ReadonlyMap<string, ArtifactRevision>,
  options: {
    readonly beforeKindLookup?: (kind: string) => Promise<void>;
    readonly failCurrentId?: string;
    readonly beforeCurrentQuery?: (id: string) => Promise<void>;
  } = {},
): ArtifactReadHost {
  return {
    listKinds: async (requestedKind) => {
      await options.beforeKindLookup?.(requestedKind);
      return registrations.filter((registration) => registration.kind === requestedKind);
    },
    resolveCurrent: async ({ kind: requestedKind, id }) => {
      if (id === options.failCurrentId) throw new Error('store temporarily unavailable');
      await options.beforeCurrentQuery?.(id);
      const requested = current.filter((entry) => entry.kind === requestedKind && entry.id === id);
      if (requested.length > 1)
        throw new Error(`Current artifact lookup for '${requestedKind}:${id}' returned multiple revisions.`);
      return requested[0] ?? null;
    },
    resolvePinned: async (ref: ArtifactRef) => pinned.get(`${ref.kind}:${ref.id}@${ref.revision}`) ?? null,
  };
}

function execute(input: ReadArtifactsInput, artifactHost?: ArtifactReadHost) {
  return executeReadArtifacts(input, createMakaioContext(), artifactHost);
}

function successfulData(result: Awaited<ReturnType<typeof execute>>) {
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

describe('artifacts_read', () => {
  it('fails closed without a host before any raw bus request and leaves the default package unbound', async () => {
    let rawBusRequests = 0;
    const context = {
      ...createMakaioContext(),
      bus: {
        request: () => {
          rawBusRequests += 1;
          throw new Error('An unbound selected reader must not use a raw bus.');
        },
      },
    } as unknown as ToolExecutionContext;

    const result = await executeReadArtifacts(
      { purpose: 'I need to read a decision.', reads: [{ ref: { kind: 'decision', id: 'current-id' } }] },
      context,
    );

    expect(result).toMatchObject({ success: false, error: { code: 'PERMISSION_DENIED' } });
    expect(rawBusRequests).toBe(0);
    // The unbound contribution must remain empty even before activation provides a context.
    expect(Reflect.apply(artifactQueryPackage.tools!.createToolsets!, undefined, [])).toEqual([]);
    expect(Reflect.apply(createArtifactQueryPackage().tools!.createToolsets!, undefined, [])).toEqual([]);
  });

  it('keeps current and pinned reads inside the supplied host boundary', async () => {
    const repoACurrent = artifact('shared-id', 'rev-2', { subject: 'Repo A', statement: 'Only A is visible' });
    const repoAPinned = artifact('shared-id', 'rev-1', {
      subject: 'Repo A history',
      statement: 'Only A history is visible',
    });
    const repoBCurrent = artifact('shared-id', 'rev-2', { subject: 'Repo B', statement: 'Must not be visible' });
    const repoBPinned = artifact('shared-id', 'rev-1', { subject: 'Repo B history', statement: 'Must not be visible' });
    const byRepository = new Map([
      [
        'A',
        {
          current: [repoACurrent],
          pinned: new Map([['decision:shared-id@rev-1', repoAPinned]]),
        },
      ],
      [
        'B',
        {
          current: [repoBCurrent],
          pinned: new Map([['decision:shared-id@rev-1', repoBPinned]]),
        },
      ],
    ]);
    const readHost: ArtifactReadHost = {
      listKinds: async (_kind, context) => {
        const repository = (context.turnContext as { readonly repository?: string } | undefined)?.repository;
        if (!repository || !byRepository.has(repository)) throw new Error('Missing authorized repository context.');
        return [kind];
      },
      resolveCurrent: async (ref, context) => {
        const repository = (context.turnContext as { readonly repository?: string } | undefined)?.repository;
        const records = repository ? byRepository.get(repository) : undefined;
        if (!records) throw new Error('Missing authorized repository context.');
        return records.current.find((entry) => entry.kind === ref.kind && entry.id === ref.id) ?? null;
      },
      resolvePinned: async (ref, context) => {
        const repository = (context.turnContext as { readonly repository?: string } | undefined)?.repository;
        const records = repository ? byRepository.get(repository) : undefined;
        if (!records) throw new Error('Missing authorized repository context.');
        return records.pinned.get(`${ref.kind}:${ref.id}@${ref.revision}`) ?? null;
      },
    };
    const input = {
      purpose: 'I need the authorized repository decision history.',
      reads: [
        { ref: { kind: 'decision', id: 'shared-id' } },
        { ref: { kind: 'decision', id: 'shared-id', revision: 'rev-1' } },
        { ref: { kind: 'decision', id: 'foreign-only' } },
        { ref: { kind: 'decision', id: 'foreign-only', revision: 'rev-1' } },
      ],
    };
    const contextFor = (repository: string): ToolExecutionContext => ({
      ...createMakaioContext(),
      turnContext: { repository },
    });
    const resultA = successfulData(await executeReadArtifacts(input, contextFor('A'), readHost));
    const resultB = successfulData(await executeReadArtifacts(input, contextFor('B'), readHost));

    expect(resultA.results[0]).toMatchObject({ ok: true, data: { subject: 'Repo A', statement: 'Only A is visible' } });
    expect(resultA.results[1]).toMatchObject({
      ok: true,
      data: { subject: 'Repo A history', statement: 'Only A history is visible' },
    });
    expect(resultA.results[2]).toMatchObject({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND' } });
    expect(resultA.results[3]).toMatchObject({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND' } });
    expect(resultB.results[0]).toMatchObject({
      ok: true,
      data: { subject: 'Repo B', statement: 'Must not be visible' },
    });
    expect(resultB.results[1]).toMatchObject({
      ok: true,
      data: { subject: 'Repo B history', statement: 'Must not be visible' },
    });
    expect(resultB.results[2]).toMatchObject({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND' } });
    expect(resultB.results[3]).toMatchObject({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND' } });
  });

  it('keeps ordered successful and unavailable reads separate while pinning explicit revisions', async () => {
    const current = artifact('current-id', 'rev-2', { subject: 'Checkout', statement: 'Keep buttons blue' });
    const old = artifact('pinned-id', 'rev-1', { subject: 'Payments', statement: 'Use provider A' });
    const result = successfulData(
      await execute(
        {
          purpose: 'I am checking the implementation constraints.',
          reads: [
            { ref: { kind: 'decision', id: 'current-id' } },
            { ref: { kind: 'decision', id: 'pinned-id', revision: 'rev-1' }, view: 'full' },
            { ref: { kind: 'decision', id: 'missing-id', revision: 'rev-9' } },
          ],
        },
        host([kind], [current], new Map([['decision:pinned-id@rev-1', old]])),
      ),
    );

    expect(result.results).toEqual([
      {
        ok: true,
        ref: { refClass: 'artifact', kind: 'decision', id: 'current-id', revision: 'rev-2' },
        title: 'Checkout',
        data: { subject: 'Checkout', statement: 'Keep buttons blue' },
        selection: { mode: 'view', view: 'compact', fields: ['subject', 'statement'], omittedAbsentFields: [] },
      },
      {
        ok: true,
        ref: { refClass: 'artifact', kind: 'decision', id: 'pinned-id', revision: 'rev-1' },
        title: 'Payments',
        data: { subject: 'Payments', statement: 'Use provider A' },
        selection: { mode: 'full', fields: [], omittedAbsentFields: [] },
      },
      {
        ok: false,
        ref: { kind: 'decision', id: 'missing-id', revision: 'rev-9' },
        error: { code: 'ARTIFACT_NOT_FOUND', message: "Artifact 'decision:missing-id' was not found." },
      },
    ]);
  });

  it('preserves whole terminal lists, reports absent optional fields, and does not alias artifact data', async () => {
    const data = {
      subject: 'Checkout',
      statement: 'Keep buttons blue',
      details: { rationale: 'Accessibility', examples: ['Primary CTA'] },
    };
    const current = artifact('current-id', 'rev-2', data);
    const result = successfulData(
      await execute(
        {
          purpose: 'I need the implementation detail.',
          reads: [
            {
              ref: { kind: 'decision', id: 'current-id' },
              fields: ['details', 'details.rationale', 'details.examples'],
            },
            { ref: { kind: 'decision', id: 'current-id' }, fields: ['subject', 'details.optionalNote'] },
          ],
        },
        host([kind], [current], new Map()),
      ),
    );

    expect(result.results[0]).toMatchObject({
      ok: true,
      data: { details: { rationale: 'Accessibility', examples: ['Primary CTA'] } },
    });
    if (result.results[0]?.ok) {
      (result.results[0].data.details as { rationale: string }).rationale = 'Changed response';
    }
    expect(data.details.rationale).toBe('Accessibility');
    expect(result.results[1]).toEqual({
      ok: true,
      ref: { refClass: 'artifact', kind: 'decision', id: 'current-id', revision: 'rev-2' },
      title: 'Checkout',
      data: { subject: 'Checkout' },
      selection: {
        mode: 'fields',
        fields: ['subject', 'details.optionalNote'],
        omittedAbsentFields: ['details.optionalNote'],
      },
    });
  });

  it('fails visibly for invalid schema data and a mismatched pinned response', async () => {
    const malformed = artifact('invalid-id', 'rev-2', {
      subject: 'Checkout',
      statement: 'Keep buttons blue',
      details: {},
    });
    const mismatchedPinned = artifact('pinned-id', 'rev-2', { subject: 'Payments', statement: 'Use provider A' });
    const result = successfulData(
      await execute(
        {
          purpose: 'I am checking an imported artifact.',
          reads: [
            { ref: { kind: 'decision', id: 'invalid-id' } },
            { ref: { kind: 'decision', id: 'pinned-id', revision: 'rev-1' } },
          ],
        },
        host([kind], [malformed], new Map([['decision:pinned-id@rev-1', mismatchedPinned]])),
      ),
    );

    expect(result.results).toEqual([
      {
        ok: false,
        ref: { kind: 'decision', id: 'invalid-id' },
        error: {
          code: 'SCHEMA_MISMATCH',
          message: "Artifact 'invalid-id' revision 'rev-2' does not satisfy the registered 'decision' data schema.",
        },
      },
      {
        ok: false,
        ref: { kind: 'decision', id: 'pinned-id', revision: 'rev-1' },
        error: {
          code: 'ARTIFACT_LOOKUP_FAILED',
          message:
            "Artifact lookup failed: Pinned artifact lookup for 'decision:pinned-id@rev-1' returned a different revision.",
        },
      },
    ]);
  });

  it('uses the registration matching each resolved artifact schema version', async () => {
    const versionTwoKind = ArtifactKindRegistrationSchema.parse({
      ...kind,
      schemaVersion: 2,
      views: { compact: { fields: ['subject'] } },
    });
    const current = artifact(
      'current-version-two',
      'rev-2',
      { subject: 'Checkout', statement: 'Keep buttons blue' },
      { schemaVersion: 2 },
    );
    const historical = artifact('historical-version-one', 'rev-1', {
      subject: 'Payments',
      statement: 'Use provider A',
    });
    const unsupported = artifact(
      'unsupported-version',
      'rev-3',
      { subject: 'Shipping', statement: 'Notify customers' },
      { schemaVersion: 3 },
    );
    const result = successfulData(
      await execute(
        {
          purpose: 'I need to read current and pinned decision revisions.',
          reads: [
            { ref: { kind: 'decision', id: 'current-version-two' } },
            { ref: { kind: 'decision', id: 'historical-version-one', revision: 'rev-1' } },
            { ref: { kind: 'decision', id: 'unsupported-version' } },
          ],
        },
        host(
          [kind, versionTwoKind],
          [current, unsupported],
          new Map([['decision:historical-version-one@rev-1', historical]]),
        ),
      ),
    );

    expect(result.results[0]).toMatchObject({
      ok: true,
      ref: { revision: 'rev-2' },
      data: { subject: 'Checkout' },
      selection: { fields: ['subject'] },
    });
    expect(result.results[1]).toMatchObject({
      ok: true,
      ref: { revision: 'rev-1' },
      data: { subject: 'Payments', statement: 'Use provider A' },
      selection: { fields: ['subject', 'statement'] },
    });
    expect(result.results[2]).toMatchObject({ ok: false, error: { code: 'SCHEMA_VERSION_MISMATCH' } });
  });

  it('uses the artifact data-schema dialect for date-time offsets', async () => {
    const valid = artifact('offset-id', 'rev-1', {
      subject: 'Checkout',
      statement: 'Keep buttons blue',
      publishedAt: '2026-09-09T20:00:00+02:00',
    });
    const malformed = artifact('malformed-date-id', 'rev-1', {
      subject: 'Payments',
      statement: 'Use provider A',
      publishedAt: 'not-a-date',
    });
    const result = successfulData(
      await execute(
        {
          purpose: 'I need to confirm the recorded decision dates.',
          reads: [
            { ref: { kind: 'decision', id: 'offset-id' }, view: 'full' },
            { ref: { kind: 'decision', id: 'malformed-date-id' }, view: 'full' },
          ],
        },
        host([kind], [valid, malformed], new Map()),
      ),
    );

    expect(result.results[0]).toMatchObject({ ok: true, data: { publishedAt: '2026-09-09T20:00:00+02:00' } });
    expect(result.results[1]).toMatchObject({ ok: false, error: { code: 'SCHEMA_MISMATCH' } });
  });

  it('uses a fallback only for an undeclared default compact view, while explicit views fail visibly', async () => {
    const noViews = ArtifactKindRegistrationSchema.parse({ ...kind, views: undefined });
    const current = artifact('current-id', 'rev-2', { subject: 'Checkout', statement: 'Keep buttons blue' });
    const result = successfulData(
      await execute(
        {
          purpose: 'I need a concise decision summary.',
          reads: [
            { ref: { kind: 'decision', id: 'current-id' } },
            { ref: { kind: 'decision', id: 'current-id' }, view: 'compact' },
            { ref: { kind: 'decision', id: 'current-id' }, view: 'reviewer' },
          ],
        },
        host([noViews], [current], new Map()),
      ),
    );

    expect(result.results[0]).toMatchObject({
      ok: true,
      data: {},
      selection: {
        mode: 'fallback',
        guidance: 'No compact view is declared. Request fields explicitly or request view "full".',
      },
    });
    expect(result.results.slice(1)).toEqual([
      {
        ok: false,
        ref: { kind: 'decision', id: 'current-id' },
        error: {
          code: 'VIEW_NOT_FOUND',
          message: "View 'compact' is not available for artifact kind 'decision'. Available views: full.",
        },
      },
      {
        ok: false,
        ref: { kind: 'decision', id: 'current-id' },
        error: {
          code: 'VIEW_NOT_FOUND',
          message: "View 'reviewer' is not available for artifact kind 'decision'. Available views: full.",
        },
      },
    ]);
  });

  it('retains successful siblings after a lookup failure and preserves empty JSON values', async () => {
    const current = [
      artifact('current-id', 'rev-2', { subject: 'Checkout', statement: '', details: { rationale: '', examples: [] } }),
      artifact('failing-id', 'rev-2', { subject: 'Payments', statement: 'Use provider A' }),
    ];
    const result = successfulData(
      await execute(
        {
          purpose: 'I am checking exact stored values.',
          reads: [
            {
              ref: { kind: 'decision', id: 'current-id' },
              fields: ['statement', 'details.rationale', 'details.examples'],
            },
            { ref: { kind: 'decision', id: 'failing-id' } },
          ],
        },
        host([kind], current, new Map(), { failCurrentId: 'failing-id' }),
      ),
    );

    expect(result.results[0]).toMatchObject({
      ok: true,
      data: { statement: '', details: { rationale: '', examples: [] } },
    });
    expect(result.results[1]).toMatchObject({ ok: false, error: { code: 'ARTIFACT_LOOKUP_FAILED' } });
  });

  it('keeps a returned current revision addressable after the current head advances', async () => {
    const original = artifact('current-id', 'rev-1', { subject: 'Checkout', statement: 'Keep buttons blue' });
    const head = [original];
    const artifactHost = host([kind], head, new Map([['decision:current-id@rev-1', original]]));
    const first = successfulData(
      await execute(
        { purpose: 'I am starting implementation planning.', reads: [{ ref: { kind: 'decision', id: 'current-id' } }] },
        artifactHost,
      ),
    );
    head[0] = artifact('current-id', 'rev-2', { subject: 'Checkout', statement: 'Use a blue checkout button.' });
    const second = successfulData(
      await execute(
        {
          purpose: 'I need to verify the revision I already read.',
          reads: [{ ref: { kind: 'decision', id: 'current-id', revision: 'rev-1' } }],
        },
        artifactHost,
      ),
    );

    expect(first.results[0]).toMatchObject({ ok: true, ref: { id: 'current-id', revision: 'rev-1' } });
    expect(second.results[0]).toMatchObject({ ok: true, ref: { id: 'current-id', revision: 'rev-1' } });
  });

  it('bounds concurrent independent current reads while retaining request order', async () => {
    const current = Array.from({ length: 9 }, (_, index) =>
      artifact(`current-${index}`, 'rev-1', { subject: `Subject ${index}`, statement: `Statement ${index}` }),
    );
    let activeReads = 0;
    let maximumActiveReads = 0;
    const result = successfulData(
      await execute(
        {
          purpose: 'I need the current decisions in the requested order.',
          reads: current.map((entry) => ({ ref: { kind: entry.kind, id: entry.id } })),
        },
        host([kind], current, new Map(), {
          beforeCurrentQuery: async () => {
            activeReads += 1;
            maximumActiveReads = Math.max(maximumActiveReads, activeReads);
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            activeReads -= 1;
          },
        }),
      ),
    );

    expect(maximumActiveReads).toBeLessThanOrEqual(4);
    expect(result.results.map((entry) => entry.ref.id)).toEqual(current.map((entry) => entry.id));
  });

  it('bounds concurrent distinct-kind lookups before resolving reads', async () => {
    const kinds = Array.from({ length: 9 }, (_, index) =>
      ArtifactKindRegistrationSchema.parse({ ...kind, kind: `decision-${index}` }),
    );
    let activeLookups = 0;
    let maximumActiveLookups = 0;
    const result = successfulData(
      await execute(
        {
          purpose: 'I need to check the available decision kinds.',
          reads: kinds.map((entry, index) => ({ ref: { kind: entry.kind, id: `missing-${index}` } })),
        },
        host(kinds, [], new Map(), {
          beforeKindLookup: async () => {
            activeLookups += 1;
            maximumActiveLookups = Math.max(maximumActiveLookups, activeLookups);
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            activeLookups -= 1;
          },
        }),
      ),
    );

    expect(maximumActiveLookups).toBeLessThanOrEqual(4);
    expect(result.results.map((entry) => entry.ref.kind)).toEqual(kinds.map((entry) => entry.kind));
  });

  it('rejects malformed requests and unsupported elementwise array paths', async () => {
    expect(
      ReadArtifactsInputSchema.safeParse({ purpose: ' ', reads: [{ ref: { kind: 'decision', id: 'current-id' } }] })
        .success,
    ).toBe(false);
    expect(
      ReadArtifactsInputSchema.safeParse({
        purpose: 'I need the decision.',
        reads: [{ ref: { kind: 'decision', id: 'current-id' }, view: 'compact', fields: ['statement'] }],
      }).success,
    ).toBe(false);
    const current = artifact('current-id', 'rev-2', {
      subject: 'Checkout',
      statement: 'Keep buttons blue',
      details: { rationale: 'Accessibility', examples: ['Primary CTA'] },
    });
    const result = successfulData(
      await execute(
        {
          purpose: 'I need the source list.',
          reads: [
            { ref: { kind: 'decision', id: 'current-id' }, fields: ['details.examples.value'] },
            { ref: { kind: 'decision', id: 'current-id' }, fields: ['__proto__'] },
          ],
        },
        host([kind], [current], new Map()),
      ),
    );
    expect(result.results[0]).toMatchObject({ ok: false, error: { code: 'FIELD_NOT_DECLARED' } });
    expect(result.results[1]).toMatchObject({ ok: false, error: { code: 'FIELD_NOT_DECLARED' } });
  });

  it('bounds per-invocation artifact and field selection work', () => {
    const selector = { ref: { kind: 'decision', id: 'current-id' } };
    expect(
      ReadArtifactsInputSchema.safeParse({
        purpose: 'I need the bounded selection.',
        reads: Array.from({ length: 100 }, () => selector),
      }).success,
    ).toBe(true);
    expect(
      ReadArtifactsInputSchema.safeParse({
        purpose: 'I need the bounded selection.',
        reads: [{ ...selector, fields: Array.from({ length: 100 }, () => 'statement') }],
      }).success,
    ).toBe(true);

    const tooManyReads = ReadArtifactsInputSchema.safeParse({
      purpose: 'I need the bounded selection.',
      reads: Array.from({ length: 101 }, () => selector),
    });
    const tooManyFields = ReadArtifactsInputSchema.safeParse({
      purpose: 'I need the bounded selection.',
      reads: [{ ...selector, fields: Array.from({ length: 101 }, () => 'statement') }],
    });

    expect(tooManyReads.success).toBe(false);
    if (!tooManyReads.success) {
      expect(tooManyReads.error.issues).toContainEqual(expect.objectContaining({ code: 'too_big', maximum: 100 }));
    }
    expect(tooManyFields.success).toBe(false);
    if (!tooManyFields.success) {
      expect(tooManyFields.error.issues).toContainEqual(expect.objectContaining({ code: 'too_big', maximum: 100 }));
    }
  });
});

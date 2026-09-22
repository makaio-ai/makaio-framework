import { describe, expect, it, vi } from 'vitest';
import type {
  ContextProjectionOccurrence,
  ContextProjectionPlan,
  ContextProjectionProjectedValue,
} from '@makaio/contracts/context-projection';
import { z } from 'zod';
import {
  ContextProjectionRegistrationError,
  ContextProjectionRegistry,
  type ContextProjectionProjector,
  type ContextProjectionSelector,
  type ContextProjectionSelectorResult,
} from './index.js';

const plan = {
  steps: [
    { op: 'select', as: 'roots', resolver: 'roots', params: { source: 'assigned' } },
    { op: 'select', as: 'parents', resolver: 'parents', from: 'roots', params: { direction: 'up' } },
    { op: 'project', as: 'summaries', resolver: 'summary', from: 'parents', params: { format: 'short' } },
    { op: 'project', as: 'details', resolver: 'detail', from: 'parents', params: { format: 'full' } },
    {
      op: 'compose',
      sections: [
        { from: 'summaries', label: 'Summaries' },
        { from: 'details', label: 'Details' },
      ],
      budget: { maxContributions: 3 },
    },
  ],
} as const satisfies ContextProjectionPlan;

function occurrence(id: string, code: string): ContextProjectionOccurrence {
  return {
    ref: { type: 'workpiece', id },
    reasons: [{ step: 'parents', code }],
  };
}

function value(view: string, source: ContextProjectionOccurrence): ContextProjectionProjectedValue {
  return {
    value: { artifact: source.ref.id, view, reason: source.reasons[0]?.code },
    provenance: { ref: source.ref, reasons: source.reasons, effectiveSelection: { view } },
  };
}

function createRegistry(): ContextProjectionRegistry<{ readonly audience: string }> {
  const registry = new ContextProjectionRegistry<{ readonly audience: string }>();
  registry.registerSelector({
    id: 'roots',
    params: z.object({ source: z.literal('assigned') }),
    async select() {
      return {
        occurrences: [occurrence('B', 'assigned-root'), occurrence('C', 'assigned-root')],
        diagnostics: [],
      };
    },
  });
  registry.registerSelector({
    id: 'parents',
    params: z.object({ direction: z.literal('up') }),
    async select(input) {
      return {
        occurrences: input.occurrences?.map((root) => occurrence('A', `parent-of-${root.ref.id}`)) ?? [],
        diagnostics: [],
      };
    },
  });
  registry.registerProjector({
    id: 'summary',
    params: z.object({ format: z.literal('short') }),
    async project(input) {
      return { contributions: input.occurrences.map((source) => value('summary', source)), diagnostics: [] };
    },
  });
  registry.registerProjector({
    id: 'detail',
    params: z.object({ format: z.literal('full') }),
    async project(input) {
      return { contributions: input.occurrences.map((source) => value('detail', source)), diagnostics: [] };
    },
  });
  return registry;
}

describe('ContextProjectionRegistry', () => {
  it('preserves occurrences and provenance while composing labelled views in plan order under a cap', async () => {
    const result = await createRegistry().evaluate(plan, { context: { audience: 'agent' } });

    expect(result.contributions).toEqual([
      {
        value: { artifact: 'A', view: 'summary', reason: 'parent-of-B' },
        provenance: {
          ref: { type: 'workpiece', id: 'A' },
          reasons: [{ step: 'parents', code: 'parent-of-B' }],
          effectiveSelection: { view: 'summary' },
        },
        section: 'Summaries',
        order: 0,
      },
      {
        value: { artifact: 'A', view: 'summary', reason: 'parent-of-C' },
        provenance: {
          ref: { type: 'workpiece', id: 'A' },
          reasons: [{ step: 'parents', code: 'parent-of-C' }],
          effectiveSelection: { view: 'summary' },
        },
        section: 'Summaries',
        order: 1,
      },
      {
        value: { artifact: 'A', view: 'detail', reason: 'parent-of-B' },
        provenance: {
          ref: { type: 'workpiece', id: 'A' },
          reasons: [{ step: 'parents', code: 'parent-of-B' }],
          effectiveSelection: { view: 'detail' },
        },
        section: 'Details',
        order: 2,
      },
    ]);
    expect(result.diagnostics).toEqual([
      {
        step: 'compose',
        severity: 'warning',
        code: 'context-projection-budget-exceeded',
        message: 'Context projection contribution budget exceeded.',
      },
    ]);
  });

  it('preflights invalid references, parameters, and resolver identifiers without invoking handlers', async () => {
    const registry = new ContextProjectionRegistry<undefined>();
    const selector = vi.fn<ContextProjectionSelector<undefined, { readonly allowed: true }>['select']>();
    registry.registerSelector({ id: 'registered', params: z.object({ allowed: z.literal(true) }), select: selector });

    const invalidReference = await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'children', resolver: 'registered', from: 'missing', params: { allowed: true } },
          { op: 'compose', sections: [] },
        ],
      } as ContextProjectionPlan,
      { context: undefined },
    );
    const invalidParams = await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'children', resolver: 'registered', params: { allowed: false } },
          { op: 'compose', sections: [] },
        ],
      } as ContextProjectionPlan,
      { context: undefined },
    );
    const unknownResolver = await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'children', resolver: 'unknown', params: null },
          { op: 'compose', sections: [] },
        ],
      },
      { context: undefined },
    );

    expect(selector).not.toHaveBeenCalled();
    expect(invalidReference.diagnostics[0]?.code).toBe('context-projection-plan-invalid');
    expect(invalidParams.diagnostics[0]?.code).toBe('context-projection-params-invalid');
    expect(unknownResolver.diagnostics[0]?.code).toBe('context-projection-resolver-not-registered');
  });

  it('rejects duplicate resolver identifiers', () => {
    const registry = new ContextProjectionRegistry<undefined>();
    const selector: ContextProjectionSelector<undefined, null> = {
      id: 'roots',
      params: z.null(),
      async select() {
        return { occurrences: [], diagnostics: [] };
      },
    };

    registry.registerSelector(selector);

    expect(() => registry.registerSelector(selector)).toThrow(ContextProjectionRegistrationError);
  });

  it('sanitizes resolver failures and rejects malformed resolver output', async () => {
    const registry = new ContextProjectionRegistry<undefined>();
    registry.registerSelector({
      id: 'throws',
      params: z.null(),
      async select() {
        throw new Error('secret resolver implementation detail');
      },
    });
    registry.registerSelector({
      id: 'invalid',
      params: z.null(),
      async select() {
        const output: ContextProjectionSelectorResult = { occurrences: [occurrence('A', 'selected')], diagnostics: [] };
        Reflect.deleteProperty(output.occurrences[0]!, 'ref');
        return output;
      },
    });

    const failure = await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'failed', resolver: 'throws', params: null },
          { op: 'compose', sections: [] },
        ],
      },
      { context: undefined },
    );
    const malformed = await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'invalid', resolver: 'invalid', params: null },
          { op: 'compose', sections: [] },
        ],
      },
      { context: undefined },
    );

    expect(failure.diagnostics[0]).toMatchObject({ code: 'context-projection-step-failed' });
    expect(failure.diagnostics[0]?.message).not.toContain('secret resolver implementation detail');
    expect(malformed.diagnostics[0]).toMatchObject({ code: 'context-projection-output-invalid' });
  });

  it('passes the caller signal to handlers and propagates an abort', async () => {
    const registry = new ContextProjectionRegistry<undefined>();
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    const select = vi.fn(async (input: Parameters<ContextProjectionSelector<undefined, null>['select']>[0]) => {
      expect(input.signal).toBe(controller.signal);
      controller.abort(reason);
      return { occurrences: [], diagnostics: [] };
    });
    registry.registerSelector({ id: 'abort', params: z.null(), select });

    await expect(
      registry.evaluate(
        {
          steps: [
            { op: 'select', as: 'selected', resolver: 'abort', params: null },
            { op: 'compose', sections: [] },
          ],
        },
        { context: undefined, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(select).toHaveBeenCalledOnce();
  });

  it('skips dependent selectors and projectors after a select fails', async () => {
    const registry = new ContextProjectionRegistry<undefined>();
    const dependentSelector = vi.fn<ContextProjectionSelector<undefined, null>['select']>();
    const projector = vi.fn<ContextProjectionProjector<undefined, null>['project']>();
    registry.registerSelector({
      id: 'fails',
      params: z.null(),
      async select() {
        throw new Error('source unavailable');
      },
    });
    registry.registerSelector({ id: 'dependent', params: z.null(), select: dependentSelector });
    registry.registerProjector({ id: 'project', params: z.null(), project: projector });

    const result = await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'failed', resolver: 'fails', params: null },
          { op: 'select', as: 'dependent', resolver: 'dependent', from: 'failed', params: null },
          { op: 'project', as: 'view', resolver: 'project', from: 'failed', params: null },
          { op: 'compose', sections: [] },
        ],
      },
      { context: undefined },
    );

    expect(dependentSelector).not.toHaveBeenCalled();
    expect(projector).not.toHaveBeenCalled();
    expect(result.diagnostics.map((entry) => [entry.step, entry.code])).toEqual([
      ['failed', 'context-projection-step-failed'],
      ['dependent', 'context-projection-dependency-failed'],
      ['view', 'context-projection-dependency-failed'],
    ]);
  });

  it('passes valid empty selections to downstream resolvers', async () => {
    const registry = new ContextProjectionRegistry<undefined>();
    const downstreamSelector = vi.fn<ContextProjectionSelector<undefined, null>['select']>(async (input) => {
      expect(input.occurrences).toEqual([]);
      return { occurrences: [], diagnostics: [] };
    });
    const projector = vi.fn<ContextProjectionProjector<undefined, null>['project']>(async (input) => {
      expect(input.occurrences).toEqual([]);
      return { contributions: [], diagnostics: [] };
    });
    registry.registerSelector({
      id: 'empty',
      params: z.null(),
      async select() {
        return { occurrences: [], diagnostics: [] };
      },
    });
    registry.registerSelector({ id: 'downstream', params: z.null(), select: downstreamSelector });
    registry.registerProjector({ id: 'project', params: z.null(), project: projector });

    await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'roots', resolver: 'empty', params: null },
          { op: 'select', as: 'children', resolver: 'downstream', from: 'roots', params: null },
          { op: 'project', as: 'view', resolver: 'project', from: 'children', params: null },
          { op: 'compose', sections: [] },
        ],
      },
      { context: undefined },
    );

    expect(downstreamSelector).toHaveBeenCalledOnce();
    expect(projector).toHaveBeenCalledOnce();
  });

  it('identifies each alias when a selector and projector resolver are reused', async () => {
    const registry = new ContextProjectionRegistry<undefined>();
    const selectedSteps: string[] = [];
    const projectedSteps: string[] = [];
    registry.registerSelector({
      id: 'reused-selector',
      params: z.null(),
      async select(input) {
        selectedSteps.push(input.step);
        return { occurrences: [occurrence('A', `selected-by-${input.step}`)], diagnostics: [] };
      },
    });
    registry.registerProjector({
      id: 'reused-projector',
      params: z.null(),
      async project(input) {
        projectedSteps.push(input.step);
        return {
          contributions: input.occurrences.map((source) => value(input.step, source)),
          diagnostics: [],
        };
      },
    });

    const result = await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'first-source', resolver: 'reused-selector', params: null },
          { op: 'select', as: 'second-source', resolver: 'reused-selector', params: null },
          { op: 'project', as: 'first-view', resolver: 'reused-projector', from: 'first-source', params: null },
          { op: 'project', as: 'second-view', resolver: 'reused-projector', from: 'second-source', params: null },
          {
            op: 'compose',
            sections: [
              { from: 'first-view', label: 'First' },
              { from: 'second-view', label: 'Second' },
            ],
          },
        ],
      },
      { context: undefined },
    );

    expect(selectedSteps).toEqual(['first-source', 'second-source']);
    expect(projectedSteps).toEqual(['first-view', 'second-view']);
    expect(result.contributions.map((entry) => [entry.value, entry.provenance.reasons, entry.section])).toEqual([
      [
        { artifact: 'A', view: 'first-view', reason: 'selected-by-first-source' },
        [{ step: 'parents', code: 'selected-by-first-source' }],
        'First',
      ],
      [
        { artifact: 'A', view: 'second-view', reason: 'selected-by-second-source' },
        [{ step: 'parents', code: 'selected-by-second-source' }],
        'Second',
      ],
    ]);
  });

  it('awaits asynchronous parameter schemas before invoking any handlers', async () => {
    const asyncParams = z.object({ allowed: z.string().refine(async (entry) => entry === 'yes') });
    const validRegistry = new ContextProjectionRegistry<undefined>();
    const validHandler = vi.fn<ContextProjectionSelector<undefined, { readonly allowed: string }>['select']>(
      async (input) => {
        expect(input.params).toEqual({ allowed: 'yes' });
        return { occurrences: [], diagnostics: [] };
      },
    );
    validRegistry.registerSelector({ id: 'async', params: asyncParams, select: validHandler });

    await validRegistry.evaluate(
      {
        steps: [
          { op: 'select', as: 'accepted', resolver: 'async', params: { allowed: 'yes' } },
          { op: 'compose', sections: [] },
        ],
      },
      { context: undefined },
    );
    expect(validHandler).toHaveBeenCalledOnce();

    const invalidRegistry = new ContextProjectionRegistry<undefined>();
    const earlierHandler = vi.fn<ContextProjectionSelector<undefined, null>['select']>();
    const rejectedHandler = vi.fn<ContextProjectionSelector<undefined, { readonly allowed: string }>['select']>();
    invalidRegistry.registerSelector({ id: 'earlier', params: z.null(), select: earlierHandler });
    invalidRegistry.registerSelector({ id: 'async', params: asyncParams, select: rejectedHandler });

    const rejected = await invalidRegistry.evaluate(
      {
        steps: [
          { op: 'select', as: 'earlier', resolver: 'earlier', params: null },
          { op: 'select', as: 'rejected', resolver: 'async', params: { allowed: 'no' } },
          { op: 'compose', sections: [] },
        ],
      },
      { context: undefined },
    );

    expect(earlierHandler).not.toHaveBeenCalled();
    expect(rejectedHandler).not.toHaveBeenCalled();
    expect(rejected.diagnostics).toMatchObject([{ step: 'rejected', code: 'context-projection-params-invalid' }]);
  });

  it('propagates cancellation during asynchronous parameter preflight before later refinements or callbacks', async () => {
    const registry = new ContextProjectionRegistry<undefined>();
    const controller = new AbortController();
    const reason = new Error('cancelled during preflight');
    const laterRefinement = vi.fn(async () => true);
    const selector = vi.fn<ContextProjectionSelector<undefined, null>['select']>();
    const laterSelector = vi.fn<ContextProjectionSelector<undefined, null>['select']>();
    const projector = vi.fn<ContextProjectionProjector<undefined, null>['project']>();
    registry.registerSelector({
      id: 'abort',
      params: z.null().refine(async () => {
        controller.abort(reason);
        return false;
      }),
      select: selector,
    });
    registry.registerSelector({ id: 'later', params: z.null().refine(laterRefinement), select: laterSelector });
    registry.registerProjector({ id: 'project', params: z.null(), project: projector });

    await expect(
      registry.evaluate(
        {
          steps: [
            { op: 'select', as: 'first', resolver: 'abort', params: null },
            { op: 'select', as: 'later', resolver: 'later', params: null },
            { op: 'project', as: 'view', resolver: 'project', from: 'later', params: null },
            { op: 'compose', sections: [] },
          ],
        },
        { context: undefined, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(laterRefinement).not.toHaveBeenCalled();
    expect(selector).not.toHaveBeenCalled();
    expect(laterSelector).not.toHaveBeenCalled();
    expect(projector).not.toHaveBeenCalled();
  });

  it('composes repeated sections deterministically up to the contribution cap', async () => {
    const registry = new ContextProjectionRegistry<undefined>();
    registry.registerSelector({
      id: 'roots',
      params: z.null(),
      async select() {
        return { occurrences: [occurrence('A', 'selected')], diagnostics: [] };
      },
    });
    registry.registerProjector({
      id: 'views',
      params: z.null(),
      async project(input) {
        return {
          contributions: input.occurrences.flatMap((source) => [value('first', source), value('second', source)]),
          diagnostics: [],
        };
      },
    });

    const result = await registry.evaluate(
      {
        steps: [
          { op: 'select', as: 'roots', resolver: 'roots', params: null },
          { op: 'project', as: 'views', resolver: 'views', from: 'roots', params: null },
          {
            op: 'compose',
            sections: [
              { from: 'views', label: 'Primary' },
              { from: 'views', label: 'Repeated' },
            ],
            budget: { maxContributions: 3 },
          },
        ],
      },
      { context: undefined },
    );

    expect(result.contributions.map((entry) => [entry.value, entry.section, entry.order])).toEqual([
      [{ artifact: 'A', view: 'first', reason: 'selected' }, 'Primary', 0],
      [{ artifact: 'A', view: 'second', reason: 'selected' }, 'Primary', 1],
      [{ artifact: 'A', view: 'first', reason: 'selected' }, 'Repeated', 2],
    ]);
    expect(result.diagnostics).toMatchObject([{ code: 'context-projection-budget-exceeded', severity: 'warning' }]);
  });
});

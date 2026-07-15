import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects, ArtifactViewModelSchema, MaterializationSubjects } from '@makaio/contracts';
import type {
  ArtifactProjectionPolicy,
  ArtifactRevision,
  ArtifactViewAffordanceRequest,
  ArtifactViewBuilder,
  ArtifactViewLevel,
  ArtifactViewSection,
  ResolvedArtifactContextWire,
} from '@makaio/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactSchemaRegistry } from '../../artifact/artifact-schema-registry.js';
import { ArtifactViewBuilderRegistry } from '../artifact-view-builder-registry.js';
import { ArtifactViewService, isAffordancePermitted } from '../artifact-view-service.js';
import { GENERIC_ARTIFACT_VIEW_BUILDER_VERSION } from '../generic-artifact-view-builder.js';
import { makeBuilder, makeRegistration as makeKindRegistration, makeRevision as makeArtifact } from './helpers.js';

/* -------------------------------------------------------------------------- */
/*  isAffordancePermitted truth table tests                                   */
/* -------------------------------------------------------------------------- */

describe('isAffordancePermitted', () => {
  /* ---------------------------------------------------------------------- */
  /*  Absent affordances — legacy defaults                                  */
  /* ---------------------------------------------------------------------- */

  describe('absent affordances (legacy defaults)', () => {
    it('mode none + absent affordances = not permitted', () => {
      const projection: ArtifactProjectionPolicy = { mode: 'none' };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'full')).toBe(false);
    });

    it('mode surface + absent affordances + own-view/full = permitted', () => {
      const projection: ArtifactProjectionPolicy = { mode: 'surface' };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'full')).toBe(true);
    });

    it('mode surface + absent affordances + own-view/summary = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = { mode: 'surface' };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'summary')).toBe(false);
    });

    it('mode surface + absent affordances + inline = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = { mode: 'surface' };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'full')).toBe(false);
    });

    it('mode comment + absent affordances + inline/summary = permitted', () => {
      const projection: ArtifactProjectionPolicy = { mode: 'comment' };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'child' }, 'summary')).toBe(true);
    });

    it('mode comment + absent affordances + own-view = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = { mode: 'comment' };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'full')).toBe(false);
    });

    it('mode comment + absent affordances + inline/full = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = { mode: 'comment' };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'child' }, 'full')).toBe(false);
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Present empty affordances                                             */
  /* ---------------------------------------------------------------------- */

  describe('present empty affordances', () => {
    it('empty affordances array = NOT permitted regardless of mode surface', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [],
      };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'full')).toBe(false);
    });

    it('empty affordances array = NOT permitted for inline request', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'comment',
        affordances: [],
      };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'summary')).toBe(false);
    });

    it('empty affordances array = NOT permitted for entry request', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [],
      };
      expect(isAffordancePermitted(projection, { kind: 'entry', via: 'sidebar' }, 'full')).toBe(false);
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Present non-empty affordances — exact matching                        */
  /* ---------------------------------------------------------------------- */

  describe('present non-empty affordances (exact matching)', () => {
    it('own-view declaration matches own-view request at full', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'own-view' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'full')).toBe(true);
    });

    it('own-view declaration does NOT match at summary level', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'own-view' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'summary')).toBe(false);
    });

    it('own-view declaration does NOT match at link level', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'own-view' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'link')).toBe(false);
    });

    it('inline with matching hostRelation at full = permitted (omitted as defaults to full)', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'inline', hostRelation: 'parent' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'full')).toBe(true);
    });

    it('inline with omitted as, request at summary = NOT permitted (omitted as matches only full)', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'inline', hostRelation: 'parent' }],
      };
      // Omitted `as` defaults to `full`. Matching is exact equality, so a
      // summary request does not match the declared full level.
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'summary')).toBe(false);
    });

    it('inline with omitted as, request at link = NOT permitted (omitted as matches only full)', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'inline', hostRelation: 'parent' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'link')).toBe(false);
    });

    it('inline with as=summary, request at summary = permitted', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'inline', hostRelation: 'parent', as: 'summary' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'summary')).toBe(true);
    });

    it('inline with as=summary, request at link = NOT permitted (exact equality required)', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'inline', hostRelation: 'parent', as: 'summary' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'link')).toBe(false);
    });

    it('inline with as=summary, request at full = NOT permitted (exact equality required)', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'inline', hostRelation: 'parent', as: 'summary' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'full')).toBe(false);
    });

    it('inline with wrong hostRelation = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'inline', hostRelation: 'parent' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'child' }, 'full')).toBe(false);
    });

    it('entry with matching via = permitted', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'entry', via: 'sidebar' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'entry', via: 'sidebar' }, 'full')).toBe(true);
    });

    it('entry with matching collection = permitted', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'entry', collection: 'artifacts' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'entry', collection: 'artifacts' }, 'full')).toBe(true);
    });

    it('entry via mismatch = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'entry', via: 'sidebar' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'entry', via: 'toolbar' }, 'full')).toBe(false);
    });

    it('entry collection mismatch = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'entry', collection: 'artifacts' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'entry', collection: 'issues' }, 'full')).toBe(false);
    });

    it('entry with via declaration but collection request = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'entry', via: 'sidebar' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'entry', collection: 'artifacts' }, 'full')).toBe(false);
    });

    it('entry with collection declaration but via request = NOT permitted', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'entry', collection: 'artifacts' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'entry', via: 'sidebar' }, 'full')).toBe(false);
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Undefined projection                                                  */
  /* ---------------------------------------------------------------------- */

  describe('undefined projection', () => {
    it('undefined projection = NOT permitted (treated as mode none)', () => {
      expect(isAffordancePermitted(undefined, { kind: 'own-view' }, 'full')).toBe(false);
    });

    it('undefined projection with inline request = NOT permitted', () => {
      expect(isAffordancePermitted(undefined, { kind: 'inline', hostRelation: 'parent' }, 'summary')).toBe(false);
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Multiple affordances — first match wins                               */
  /* ---------------------------------------------------------------------- */

  describe('multiple affordances', () => {
    it('matches when any of multiple affordances apply', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'own-view' }, { kind: 'inline', hostRelation: 'parent', as: 'summary' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'own-view' }, 'full')).toBe(true);
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'summary')).toBe(true);
    });

    it('does not match when no affordance covers the request', () => {
      const projection: ArtifactProjectionPolicy = {
        mode: 'surface',
        affordances: [{ kind: 'own-view' }, { kind: 'entry', via: 'sidebar' }],
      };
      expect(isAffordancePermitted(projection, { kind: 'inline', hostRelation: 'parent' }, 'full')).toBe(false);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Service integration tests via bus                                         */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewService', () => {
  let bus: IMakaioBus;
  let schemaRegistry: ArtifactSchemaRegistry;
  let builderRegistry: ArtifactViewBuilderRegistry;
  let viewService: ArtifactViewService;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    bus = createBusInstance();
    schemaRegistry = new ArtifactSchemaRegistry(bus);
    builderRegistry = new ArtifactViewBuilderRegistry();
    viewService = new ArtifactViewService(bus, schemaRegistry, builderRegistry);

    await schemaRegistry.init();
    await viewService.init();
  });

  afterEach(async () => {
    await viewService.destroy();
    await schemaRegistry.destroy();
    builderRegistry.clear();
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  });

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Register a bus handler for the artifact query subject that returns
   * the specified artifacts. The handler is tracked for afterEach cleanup.
   * @param artifacts - Artifacts to return from the query handler.
   */
  function registerQueryHandler(artifacts: ArtifactRevision[]): void {
    const cleanup = bus.on(ArtifactSubjects.query, (ctx) => {
      ctx.setResult({ artifacts });
    });
    cleanups.push(cleanup);
  }

  /**
   * Register a bus handler for resolveContext that returns a known resolved
   * context graph. Tracks the handler for afterEach cleanup and records both
   * whether it was called and the exact graph it returned.
   * @returns A tracker with `called` and the `returnedContext` graph.
   */
  function registerResolveContextHandler(): {
    called: boolean;
    returnedContext: ResolvedArtifactContextWire | undefined;
  } {
    const tracker: { called: boolean; returnedContext: ResolvedArtifactContextWire | undefined } = {
      called: false,
      returnedContext: undefined,
    };
    const cleanup = bus.on(ArtifactSubjects.resolveContext, (ctx) => {
      tracker.called = true;
      const { kind, id, revision } = ctx.payload.ref;
      const rootRef = { refClass: 'artifact' as const, kind, id, revision };
      const context: ResolvedArtifactContextWire = {
        rootRef,
        refs: [],
        resolved: [
          {
            kind,
            id,
            revision,
            scope: { level: 'global' },
            schemaVersion: '1',
            data: { resolvedBy: 'resolve-context-fixture' },
            relations: [],
            actor: { kind: 'system', id: 'test' },
            timestamp: 1,
          },
        ],
      };
      tracker.returnedContext = context;
      ctx.setResult({ context });
    });
    cleanups.push(cleanup);
    return tracker;
  }

  /**
   * Convenience helper for resolving an artifact view through the bus.
   * @param ref - Artifact identity string.
   * @param level - Requested detail level.
   * @param affordance - Structural affordance selector.
   * @param params - Optional runtime parameters.
   * @returns The discriminated resolve response.
   */
  async function resolveView(
    ref: string,
    level: ArtifactViewLevel,
    affordance: ArtifactViewAffordanceRequest,
    params?: Record<string, unknown>,
  ) {
    return bus.request(MaterializationSubjects.artifact.view.resolve, {
      ref,
      level,
      affordance,
      ...(params !== undefined ? { params } : {}),
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  artifact-not-found                                                    */
  /* ---------------------------------------------------------------------- */

  describe('artifact-not-found', () => {
    it('returns artifact-not-found when no query handler is registered', async () => {
      // No handler registered — requestOptional returns { handled: false }
      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('artifact-not-found');
      expect(result.view).toBeNull();
    });

    it('returns artifact-not-found when query handler returns empty array', async () => {
      registerQueryHandler([]);
      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('artifact-not-found');
      expect(result.view).toBeNull();
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  not-rendered                                                          */
  /* ---------------------------------------------------------------------- */

  describe('not-rendered', () => {
    it('returns not-rendered when kind is not registered in schema registry', async () => {
      const artifact = makeArtifact({ kind: 'unregistered-kind' });
      registerQueryHandler([artifact]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('not-rendered');
      expect(result.view).toBeNull();
    });

    it('returns not-rendered for mode none with own-view request', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'none' } }));

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('not-rendered');
      expect(result.view).toBeNull();
    });

    it('returns not-rendered for mode surface with inline request', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      const result = await resolveView('artifact-1', 'full', { kind: 'inline', hostRelation: 'parent' });
      expect(result.status).toBe('not-rendered');
      expect(result.view).toBeNull();
    });

    it('returns not-rendered when affordances array is empty', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: { mode: 'surface', affordances: [] },
        }),
      );

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('not-rendered');
      expect(result.view).toBeNull();
    });

    it('returns not-rendered when custom builder returns render:false', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 3,
        build: async () => ({ render: false as const }),
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('not-rendered');
      expect(result.view).toBeNull();
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Generic fallback                                                      */
  /* ---------------------------------------------------------------------- */

  describe('generic fallback', () => {
    it('returns ok with GENERIC_ARTIFACT_VIEW_BUILDER_VERSION when no custom builder', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            projectedFields: [{ path: 'title', viewRole: 'title' }, { path: 'status' }],
          },
        }),
      );

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      expect(result.view).not.toBeNull();
      if (result.status === 'ok') {
        expect(result.builderVersion).toBe(GENERIC_ARTIFACT_VIEW_BUILDER_VERSION);
        expect(result.sourceRevision).toBe(artifact.revision);
      }
    });

    it('renders title from data when viewRole title field is present', async () => {
      const artifact = makeArtifact({ data: { title: 'My Artifact Title', status: 'open' } });
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            projectedFields: [{ path: 'title', viewRole: 'title' }, { path: 'status' }],
          },
        }),
      );

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.view.title).toBe('My Artifact Title');
      }
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Custom builder dispatch                                               */
  /* ---------------------------------------------------------------------- */

  describe('custom builder dispatch', () => {
    it('dispatches custom builder and uses returned sections', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      const customSections: ArtifactViewSection[] = [
        { type: 'properties', title: 'Custom Props', rows: [{ label: 'Key', value: 'Val' }] },
      ];
      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 5,
        build: async () => ({ sections: customSections }),
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.builderVersion).toBe(5);
        const propsSection = result.view.sections.find((s) => s.type === 'properties');
        expect(propsSection).toBeDefined();
        if (propsSection?.type === 'properties') {
          expect(propsSection.title).toBe('Custom Props');
          expect(propsSection.rows).toEqual([{ label: 'Key', value: 'Val' }]);
        }
      }
    });

    it('keeps generic sections when custom builder returns undefined', async () => {
      const artifact = makeArtifact({ data: { status: 'active' } });
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            projectedFields: [{ path: 'status' }],
          },
        }),
      );

      const builder = makeBuilder('test-kind', '1', 7);
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        // Custom builder version is reported even when it returns undefined
        expect(result.builderVersion).toBe(7);
        // Generic sections should still be present
        const propsSection = result.view.sections.find((s) => s.type === 'properties');
        expect(propsSection).toBeDefined();
      }
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Schema-version mismatch fallback                                      */
  /* ---------------------------------------------------------------------- */

  describe('schema-version mismatch fallback', () => {
    it('uses generic builder when custom builder is registered for different schemaVersion', async () => {
      const artifact = makeArtifact({ schemaVersion: '1' });
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      // Register builder for schemaVersion '2' — does not match artifact's '1'
      const builder = makeBuilder('test-kind', '2', 10);
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.builderVersion).toBe(GENERIC_ARTIFACT_VIEW_BUILDER_VERSION);
      }
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Builder version reporting                                             */
  /* ---------------------------------------------------------------------- */

  describe('builder version reporting', () => {
    it('reports custom builder version when custom builder is selected', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 42,
        build: async () => undefined,
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.builderVersion).toBe(42);
      }
    });

    it('reports GENERIC_ARTIFACT_VIEW_BUILDER_VERSION when no custom builder', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.builderVersion).toBe(GENERIC_ARTIFACT_VIEW_BUILDER_VERSION);
      }
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Output validation                                                     */
  /* ---------------------------------------------------------------------- */

  describe('output validation', () => {
    it('returned view passes ArtifactViewModelSchema', async () => {
      const artifact = makeArtifact({ data: { title: 'Valid Title', status: 'open' } });
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            projectedFields: [{ path: 'title', viewRole: 'title' }, { path: 'status' }],
          },
        }),
      );

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        const parseResult = ArtifactViewModelSchema.safeParse(result.view);
        if (!parseResult.success) {
          expect.unreachable(
            `ArtifactViewModelSchema validation failed:\n${JSON.stringify(parseResult.error.issues, null, 2)}`,
          );
        }
      }
    });

    it('returned view from custom builder passes ArtifactViewModelSchema', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      const customSections: ArtifactViewSection[] = [
        {
          type: 'properties',
          title: 'Details',
          rows: [
            { label: 'Status', value: 'open' },
            { label: 'Priority', value: 'high' },
          ],
        },
      ];
      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 2,
        build: async () => ({ sections: customSections }),
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        const parseResult = ArtifactViewModelSchema.safeParse(result.view);
        if (!parseResult.success) {
          expect.unreachable(
            `ArtifactViewModelSchema validation failed:\n${JSON.stringify(parseResult.error.issues, null, 2)}`,
          );
        }
      }
    });

    it('rejects the resolve request when a custom builder returns schema-violating sections', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      // Type-valid but schema-invalid: ArtifactViewLinkSchema requires a
      // non-empty label, so this malformed row link fails the final
      // ArtifactViewModelSchema parse inside the resolve handler.
      const invalidSections: ArtifactViewSection[] = [
        {
          type: 'table',
          title: 'Broken Table',
          columns: ['Name'],
          rows: [{ cells: ['row-1'], link: { url: 'https://example.com', label: '' } }],
        },
      ];
      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 9,
        build: async () => ({ sections: invalidSections }),
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      // The handler throws during final view-model validation; the bus wraps
      // handler errors in a RequestError and the request promise rejects.
      await expect(resolveView('artifact-1', 'full', { kind: 'own-view' })).rejects.toThrow(
        /artifact\.view\.resolve.*failed/,
      );
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Direct relations                                                      */
  /* ---------------------------------------------------------------------- */

  describe('direct relations', () => {
    it('passes artifact relations to builder context without target reads', async () => {
      const relations = [
        {
          type: 'references',
          target: {
            refClass: 'artifact' as const,
            kind: 'issue',
            id: 'issue-42',
            revision: 'rev-1',
          },
        },
      ];
      const artifact = makeArtifact({ relations });
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(makeKindRegistration({ projection: { mode: 'surface' } }));

      let receivedRelations: unknown;
      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 1,
        build: async (ctx) => {
          receivedRelations = ctx.relations;
          return undefined;
        },
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      expect(receivedRelations).toEqual(relations);
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Optional default-context resolution                                   */
  /* ---------------------------------------------------------------------- */

  describe('optional default-context resolution', () => {
    it('calls resolveContext when kind has defaultContext and custom builder exists', async () => {
      const defaultContext = { parent: { kinds: ['project'] } };
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: { mode: 'surface' },
          defaultContext,
        }),
      );

      const contextTracker = registerResolveContextHandler();

      const builder = makeBuilder('test-kind', '1', 1);
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      expect(contextTracker.called).toBe(true);
    });

    it('does not call resolveContext when kind has no defaultContext', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: { mode: 'surface' },
          // no defaultContext
        }),
      );

      const contextTracker = registerResolveContextHandler();

      const builder = makeBuilder('test-kind', '1', 1);
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      expect(contextTracker.called).toBe(false);
    });

    it('does not call resolveContext when there is no custom builder', async () => {
      const defaultContext = { parent: { kinds: ['project'] } };
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: { mode: 'surface' },
          defaultContext,
        }),
      );

      const contextTracker = registerResolveContextHandler();
      // No custom builder registered

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      expect(contextTracker.called).toBe(false);
    });

    it('passes the resolved context graph (not the declared selector) to the custom builder', async () => {
      const defaultContext = { parent: { kinds: ['project'] } };
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: { mode: 'surface' },
          defaultContext,
        }),
      );

      const contextTracker = registerResolveContextHandler();

      let receivedDefaultContext: unknown;
      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 1,
        build: async (ctx) => {
          receivedDefaultContext = ctx.defaultContext;
          return undefined;
        },
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      expect(contextTracker.called).toBe(true);
      // The builder receives the graph returned by the resolveContext RPC —
      // never the static selector declared on the kind registration.
      expect(receivedDefaultContext).toEqual(contextTracker.returnedContext);
      expect(receivedDefaultContext).not.toEqual(defaultContext);
    });

    it('passes undefined defaultContext to the builder when resolveContext is unhandled', async () => {
      const defaultContext = { parent: { kinds: ['project'] } };
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: { mode: 'surface' },
          defaultContext,
        }),
      );

      // No resolveContext handler registered — requestOptional is unhandled.
      let receivedDefaultContext: unknown = 'sentinel';
      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 1,
        build: async (ctx) => {
          receivedDefaultContext = ctx.defaultContext;
          return undefined;
        },
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
      expect(receivedDefaultContext).toBeUndefined();
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Builder receives correct context                                      */
  /* ---------------------------------------------------------------------- */

  describe('builder receives correct context', () => {
    it('builder receives artifact, level, affordance, params, and genericSections', async () => {
      const artifact = makeArtifact({ data: { title: 'Title', status: 'open' } });
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            projectedFields: [{ path: 'title', viewRole: 'title' }, { path: 'status' }],
          },
        }),
      );

      let receivedContext: {
        level?: ArtifactViewLevel;
        affordance?: ArtifactViewAffordanceRequest;
        params?: Record<string, unknown>;
        genericSectionsLength?: number;
        artifactId?: string;
      } = {};
      const builder: ArtifactViewBuilder = {
        kind: 'test-kind',
        schemaVersion: '1',
        version: 1,
        build: async (ctx) => {
          receivedContext = {
            level: ctx.level,
            affordance: ctx.affordance,
            params: ctx.params as Record<string, unknown> | undefined,
            genericSectionsLength: ctx.genericSections.length,
            artifactId: ctx.artifact.id,
          };
          return undefined;
        },
      };
      builderRegistry.replaceBuildersForOwner('test-owner', [builder]);

      await resolveView('artifact-1', 'full', { kind: 'own-view' }, { highlight: true });

      expect(receivedContext.level).toBe('full');
      expect(receivedContext.affordance).toEqual({ kind: 'own-view' });
      expect(receivedContext.params).toEqual({ highlight: true });
      expect(receivedContext.genericSectionsLength).toBeGreaterThanOrEqual(0);
      expect(receivedContext.artifactId).toBe('artifact-1');
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Affordance-based rendering through the full service                   */
  /* ---------------------------------------------------------------------- */

  describe('affordance-based rendering (end-to-end)', () => {
    it('renders own-view at full when affordances explicitly declare own-view', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            affordances: [{ kind: 'own-view' }],
          },
        }),
      );

      const result = await resolveView('artifact-1', 'full', { kind: 'own-view' });
      expect(result.status).toBe('ok');
    });

    it('does not render own-view at summary when only own-view affordance declared', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            affordances: [{ kind: 'own-view' }],
          },
        }),
      );

      const result = await resolveView('artifact-1', 'summary', { kind: 'own-view' });
      expect(result.status).toBe('not-rendered');
    });

    it('renders inline at summary when inline with as=summary is declared', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            affordances: [{ kind: 'inline', hostRelation: 'parent', as: 'summary' }],
          },
        }),
      );

      const result = await resolveView('artifact-1', 'summary', { kind: 'inline', hostRelation: 'parent' });
      expect(result.status).toBe('ok');
    });

    it('renders entry when entry via matches', async () => {
      const artifact = makeArtifact();
      registerQueryHandler([artifact]);
      schemaRegistry.registerKind(
        makeKindRegistration({
          projection: {
            mode: 'surface',
            affordances: [{ kind: 'entry', via: 'sidebar' }],
          },
        }),
      );

      const result = await resolveView('artifact-1', 'full', { kind: 'entry', via: 'sidebar' });
      expect(result.status).toBe('ok');
    });
  });
});

import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects, MaterializationSubjects, type ArtifactRef } from '@makaio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactSchemaRegistry } from '../../artifact/artifact-schema-registry.js';
import { ArtifactViewBuilderRegistry } from '../artifact-view-builder-registry.js';
import { ArtifactViewService } from '../artifact-view-service.js';
import { makeBuilder, makeRegistration, makeRevision } from './helpers.js';

const ref: ArtifactRef = { refClass: 'artifact', kind: 'test-kind', id: 'artifact-1', revision: 'rev-1' };

describe('ArtifactViewService', () => {
  let bus: IMakaioBus;
  let schemas: ArtifactSchemaRegistry;
  let builders: ArtifactViewBuilderRegistry;
  let service: ArtifactViewService;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    bus = createBusInstance();
    schemas = new ArtifactSchemaRegistry(bus);
    builders = new ArtifactViewBuilderRegistry();
    service = new ArtifactViewService(bus, schemas, builders);
    await schemas.init();
    await service.init();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await service.destroy();
    await builders.destroy();
    await schemas.destroy();
  });

  it('returns artifact-not-found when the exact revision cannot be resolved', async () => {
    cleanups.push(bus.on(ArtifactSubjects.resolve, (ctx) => ctx.setResult({ artifact: null })));
    const result = await bus.request(MaterializationSubjects.artifact.view.resolve, {
      ref,
      level: 'full',
      affordance: { kind: 'own-view' },
    });
    expect(result).toEqual({ status: 'artifact-not-found', view: null });
  });

  it('does not render registered kinds without explicit builder ownership', async () => {
    schemas.registerKind(makeRegistration());
    cleanups.push(bus.on(ArtifactSubjects.resolve, (ctx) => ctx.setResult({ artifact: makeRevision() })));
    const result = await bus.request(MaterializationSubjects.artifact.view.resolve, {
      ref,
      level: 'full',
      affordance: { kind: 'own-view' },
    });
    expect(result).toEqual({ status: 'not-rendered', view: null });
  });

  it('requires an exact versioned kind and builder match', async () => {
    schemas.registerKind(makeRegistration());
    builders.replaceBuildersForOwner('test', [makeBuilder('test-kind', 2)]);
    cleanups.push(bus.on(ArtifactSubjects.resolve, (ctx) => ctx.setResult({ artifact: makeRevision() })));
    const result = await bus.request(MaterializationSubjects.artifact.view.resolve, {
      ref,
      level: 'full',
      affordance: { kind: 'own-view' },
    });
    expect(result).toEqual({ status: 'not-rendered', view: null });
  });

  it('renders through an explicit builder without fetching implicit context', async () => {
    schemas.registerKind(makeRegistration());
    const build = vi.fn(async () => ({
      sections: [{ type: 'summary' as const, title: 'Result', text: 'Explicit content' }],
    }));
    builders.replaceBuildersForOwner('test', [{ kind: 'test-kind', schemaVersion: 1, version: 7, build }]);
    const resolve = vi.fn();
    const expandContext = vi.fn();
    cleanups.push(
      bus.on(ArtifactSubjects.resolve, (ctx) => {
        resolve(ctx.payload.ref);
        ctx.setResult({ artifact: makeRevision() });
      }),
    );
    cleanups.push(bus.on(ArtifactSubjects.resolveContext, expandContext));
    const result = await bus.request(MaterializationSubjects.artifact.view.resolve, {
      ref,
      level: 'full',
      affordance: { kind: 'own-view' },
      params: { language: 'en' },
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ref);
    expect(expandContext).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ params: { language: 'en' }, genericSections: [] }));
    expect(result).toEqual({
      status: 'ok',
      builderVersion: 7,
      sourceRevision: 'rev-1',
      view: {
        title: 'Test Title',
        artifact: { id: 'artifact-1', kind: 'test-kind', revision: 'rev-1' },
        sections: [{ type: 'summary', title: 'Result', text: 'Explicit content' }],
        navigation: { breadcrumbs: [], related: [] },
        links: {},
      },
    });
  });

  it('lets the builder decline a requested affordance', async () => {
    schemas.registerKind(makeRegistration());
    builders.replaceBuildersForOwner('test', [makeBuilder('test-kind', 1, 2, { render: false })]);
    cleanups.push(bus.on(ArtifactSubjects.resolve, (ctx) => ctx.setResult({ artifact: makeRevision() })));
    const result = await bus.request(MaterializationSubjects.artifact.view.resolve, {
      ref,
      level: 'summary',
      affordance: { kind: 'inline', hostRelation: 'contains' },
    });
    expect(result).toEqual({ status: 'not-rendered', view: null });
  });

  it('keeps the skeleton and builder version when the explicit builder returns undefined', async () => {
    schemas.registerKind(makeRegistration());
    builders.replaceBuildersForOwner('test', [makeBuilder('test-kind', 1, 9)]);
    cleanups.push(bus.on(ArtifactSubjects.resolve, (ctx) => ctx.setResult({ artifact: makeRevision() })));
    const result = await bus.request(MaterializationSubjects.artifact.view.resolve, {
      ref,
      level: 'full',
      affordance: { kind: 'own-view' },
    });
    expect(result).toEqual(expect.objectContaining({ status: 'ok', builderVersion: 9 }));
    if (result.status === 'ok') expect(result.view.sections).toEqual([]);
  });
});

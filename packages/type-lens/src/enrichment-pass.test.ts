import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENRICHMENT_VERSION } from './schemas.js';
import { IndexEngine, createBaseIndexStoreOperations } from './index-engine.js';
import { DEFAULT_CONTINUITY_CONFIG } from './continuity-config.js';
import { TsciAnalyzer } from './tsci-analyzer.js';
import type { ScopeIndexRecord, ScopeMeta } from './index-types.js';
import { runEnrichmentPass } from './enrichment-pass.js';
import type { LanguageAnalyzer } from './types.js';
import type { MemberInfo, SymbolNode } from './schemas.js';
import { writeFixture, writeWorkspaceTsConfig } from './__test-utils__/fixture-helpers.js';

/**
 * Create scope metadata for the test workspace.
 * @param scopePath - Absolute workspace root.
 * @returns ScopeMeta for testing.
 */
function makeScopeMeta(scopePath: string): ScopeMeta {
  return {
    key: `main:${scopePath}`,
    type: 'cwd',
    path: scopePath,
    branch: 'main',
  };
}

describe('runEnrichmentPass', () => {
  let workspace: string;
  let analyzer: TsciAnalyzer;
  let index: ScopeIndexRecord;

  // Fixture file paths.
  let fixtureA: string;
  let fixtureB: string;
  let barrel: string;
  let fixtureTypes: string;
  let ambiguousA: string;
  let ambiguousB: string;
  let ambiguousUse: string;
  let shadowedLocal: string;
  let defaultBase: string;
  let defaultUse: string;
  let tsconfigPath: string;

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-enrichment-pass-'));

    // fixture-a.ts: A service class with a method.
    fixtureA = writeFixture(workspace, 'fixture-a.ts', [
      '/** Service class providing core operations. */',
      'export class Svc {',
      '  /** Run the service operation. */',
      '  run(): void {}',
      '}',
      '',
      '/** Utility helper function. */',
      'export function util(): void {}',
      '',
    ]);

    // barrel.ts: Re-exports from fixture-a.
    barrel = writeFixture(workspace, 'barrel.ts', ["export { Svc, util } from './fixture-a.js';", '']);

    // fixture-b.ts: Caller that imports through barrel.
    fixtureB = writeFixture(workspace, 'fixture-b.ts', [
      "import { Svc, util } from './barrel.js';",
      "import { externalUtil } from './outside-target.js';",
      '',
      '/** Caller class that exercises Svc. */',
      'export class Caller {',
      '  /** Execute the call chain. */',
      '  exec(): void {',
      '    const svc = new Svc();',
      '    svc.run();',
      '    util();',
      '    externalUtil();',
      '  }',
      '}',
      '',
    ]);

    // outside-target.ts: Included in the TypeScript program but intentionally
    // omitted from the indexed file list, so enrichment must skip its call edge.
    writeFixture(workspace, 'outside-target.ts', [
      '/** Function outside the indexed symbol set. */',
      'export function externalUtil(): void {}',
      '',
    ]);

    // fixture-types.ts: Types and interfaces for shape/heritage testing.
    fixtureTypes = writeFixture(workspace, 'fixture-types.ts', [
      'export interface BaseA {',
      '  a: string;',
      '}',
      '',
      'export interface BaseB {',
      '  b: number;',
      '}',
      '',
      '/** Combined interface extending BaseA. */',
      'export interface Combined extends BaseA {',
      '  c: boolean;',
      '}',
      '',
      "export type Wide = Omit<BaseA, 'a'> & { y?: BaseB };",
      '',
    ]);

    ambiguousA = writeFixture(workspace, 'ambiguous-a.ts', [
      '/** Canonical imported interface. */',
      'export interface IThing {',
      '  selected: string;',
      '}',
      '',
    ]);

    ambiguousB = writeFixture(workspace, 'ambiguous-b.ts', [
      '/** Same name in a different module. */',
      'export interface IThing {',
      '  other: number;',
      '}',
      '',
    ]);

    ambiguousUse = writeFixture(workspace, 'ambiguous-use.ts', [
      "import { IThing } from './ambiguous-a.js';",
      '',
      '/** Interface extending an imported same-named interface. */',
      'export interface UsesThing extends IThing {',
      '  enabled: boolean;',
      '}',
      '',
    ]);

    shadowedLocal = writeFixture(workspace, 'shadowed-local.ts', [
      'export function target(): void {}',
      'export function outer(): void {',
      '  function target(): void {}',
      '  target();',
      '}',
      '',
    ]);

    defaultBase = writeFixture(workspace, 'default-base.ts', [
      '/** Named default-exported base class. */',
      'export default class DefaultBase {}',
      '',
    ]);

    defaultUse = writeFixture(workspace, 'default-use.ts', [
      "import DefaultBase from './default-base.js';",
      '',
      '/** Class extending a named default export. */',
      'export class UsesDefaultBase extends DefaultBase {}',
      '',
    ]);

    tsconfigPath = writeWorkspaceTsConfig(workspace);

    // Build the syntactic index using real IndexEngine + TsciAnalyzer.
    analyzer = new TsciAnalyzer({ tsConfigFilePath: tsconfigPath });
    const engine = new IndexEngine({
      analyzer,
      continuityConfig: DEFAULT_CONTINUITY_CONFIG,
    });
    const store = createBaseIndexStoreOperations();
    const scope = makeScopeMeta(workspace);
    const filePaths = [
      fixtureA,
      barrel,
      fixtureB,
      fixtureTypes,
      ambiguousA,
      ambiguousB,
      ambiguousUse,
      shadowedLocal,
      defaultBase,
      defaultUse,
    ];
    const result = await engine.fullIndex(scope, filePaths, store);
    index = result.index;
  });

  afterAll(() => {
    analyzer.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('materializes calls edges with checker identity', async () => {
    // Enrich the index.
    await runEnrichmentPass(index, analyzer, { scopePath: workspace });

    // Find the Caller.exec method symbol.
    const callerExec = findSymbol(index, 'exec', 'Caller');
    expect(callerExec).toBeDefined();

    // Find the Svc.run method symbol.
    const svcRun = findSymbol(index, 'run', 'Svc');
    expect(svcRun).toBeDefined();
    expect(svcRun!.embeddableUnit?.text).toContain('Run the service operation.');

    // Expect a calls edge from Caller.exec to Svc.run in outgoing.
    const outgoing = index.outgoing.get(callerExec!.symbol.id) ?? [];
    const callsToRun = outgoing.filter((e) => e.toSymbolId === svcRun!.symbol.id && e.kind === 'calls');
    expect(callsToRun).toHaveLength(1);

    // Expect the mirror in incoming.
    const incoming = index.incoming.get(svcRun!.symbol.id) ?? [];
    const callsFromExec = incoming.filter((e) => e.fromSymbolId === callerExec!.symbol.id && e.kind === 'calls');
    expect(callsFromExec).toHaveLength(1);
  });

  it('replaces name-bucket heritage edges with checker-resolved ones', async () => {
    // Combined extends BaseA.
    const combined = findSymbol(index, 'Combined');
    const baseA = findSymbol(index, 'BaseA');
    expect(combined).toBeDefined();
    expect(baseA).toBeDefined();

    const outgoing = index.outgoing.get(combined!.symbol.id) ?? [];
    const extendsEdges = outgoing.filter((e) => e.kind === 'extends');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0].toSymbolId).toBe(baseA!.symbol.id);

    // No duplicate extends edges.
    const allOutgoing = outgoing.filter((e) => e.kind === 'extends' && e.toSymbolId === baseA!.symbol.id);
    expect(allOutgoing).toHaveLength(1);
  });

  it('uses checker identity for same-named heritage targets', async () => {
    const usesThing = findSymbol(index, 'UsesThing');
    const selectedThing = findSymbolInFile(index, 'IThing', 'ambiguous-a.ts');
    const otherThing = findSymbolInFile(index, 'IThing', 'ambiguous-b.ts');
    expect(usesThing).toBeDefined();
    expect(selectedThing).toBeDefined();
    expect(otherThing).toBeDefined();

    const outgoing = index.outgoing.get(usesThing!.symbol.id) ?? [];
    const extendsEdges = outgoing.filter((e) => e.kind === 'extends');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0].toSymbolId).toBe(selectedThing!.symbol.id);
    expect(extendsEdges[0].toSymbolId).not.toBe(otherThing!.symbol.id);
  });

  it('preserves named default-export declaration names for heritage targets', async () => {
    await runEnrichmentPass(index, analyzer, { scopePath: workspace });

    const usesDefaultBase = findSymbol(index, 'UsesDefaultBase');
    const defaultBaseSymbol = findSymbolInFile(index, 'DefaultBase', 'default-base.ts');
    expect(usesDefaultBase).toBeDefined();
    expect(defaultBaseSymbol).toBeDefined();

    const outgoing = index.outgoing.get(usesDefaultBase!.symbol.id) ?? [];
    const extendsEdges = outgoing.filter((e) => e.kind === 'extends');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0].toSymbolId).toBe(defaultBaseSymbol!.symbol.id);
  });

  it('does not map local shadow call targets to indexed top-level symbols', async () => {
    await runEnrichmentPass(index, analyzer, { scopePath: workspace });

    const outer = findSymbolInFile(index, 'outer', 'shadowed-local.ts');
    const topLevelTarget = findSymbolInFile(index, 'target', 'shadowed-local.ts');
    expect(outer).toBeDefined();
    expect(topLevelTarget).toBeDefined();

    const outgoing = index.outgoing.get(outer!.symbol.id) ?? [];
    expect(outgoing).not.toContainEqual(
      expect.objectContaining({
        kind: 'calls',
        toSymbolId: topLevelTarget!.symbol.id,
      }),
    );
  });

  it('attaches resolved shapes to exported type aliases and interfaces', async () => {
    // Wide = Omit<BaseA, 'a'> & { y?: BaseB } — should have a resolved shape.
    const wide = findSymbol(index, 'Wide');
    expect(wide).toBeDefined();
    expect(wide!.resolvedShape).toBeDefined();

    if (wide!.resolvedShape?.kind === 'object') {
      // Should contain the 'y' property marked as optional.
      const yProp = wide!.resolvedShape.properties.find((p) => p.name === 'y');
      expect(yProp).toBeDefined();
      expect(yProp!.optional).toBe(true);
    }
  });

  it('attaches deterministic embeddable units', async () => {
    // Run the pass a second time to verify determinism.
    // Reset enrichment state to allow a clean comparison.
    const firstPassUnits = new Map<string, string>();
    for (const [id, record] of index.symbolsById) {
      if (record.embeddableUnit) {
        firstPassUnits.set(id, record.embeddableUnit.text);
      }
    }

    // Clear enrichment data and re-run.
    for (const record of index.symbolsById.values()) {
      record.embeddableUnit = undefined;
      record.resolvedShape = undefined;
    }
    index.enrichment = undefined;

    // Remove call edges so we can re-derive them.
    // Keep only extends/implements edges — they get replaced by heritage re-resolution.
    for (const [symbolId, edges] of index.outgoing) {
      const nonCall = edges.filter((e) => e.kind !== 'calls');
      if (nonCall.length > 0) {
        index.outgoing.set(symbolId, nonCall);
      } else {
        index.outgoing.delete(symbolId);
      }
    }
    for (const [symbolId, edges] of index.incoming) {
      const nonCall = edges.filter((e) => e.kind !== 'calls');
      if (nonCall.length > 0) {
        index.incoming.set(symbolId, nonCall);
      } else {
        index.incoming.delete(symbolId);
      }
    }

    await runEnrichmentPass(index, analyzer, { scopePath: workspace });

    // Compare embeddable unit text — must be byte-identical.
    for (const [id, record] of index.symbolsById) {
      const firstText = firstPassUnits.get(id);
      if (firstText !== undefined && record.embeddableUnit) {
        expect(record.embeddableUnit.text).toBe(firstText);
        expect(record.embeddableUnit.version).toBe(ENRICHMENT_VERSION);
      }
    }
  });

  it('stamps the index', async () => {
    expect(index.enrichment).toBeDefined();
    expect(index.enrichment?.version).toBe(ENRICHMENT_VERSION);
    expect(index.enrichment?.enrichedAt).toBeGreaterThan(0);
  });

  it('requires TsciAnalyzer for full semantic enrichment', async () => {
    await expect(runEnrichmentPass(index, createGenericAnalyzer(), { scopePath: workspace })).rejects.toThrow(
      'Semantic enrichment requires TsciAnalyzer',
    );
  });

  it('restores a custom analyzer cache size after enrichment', async () => {
    const customAnalyzer = new TsciAnalyzer({ tsConfigFilePath: tsconfigPath, maxCacheSize: 7 });
    const engine = new IndexEngine({
      analyzer: customAnalyzer,
      continuityConfig: DEFAULT_CONTINUITY_CONFIG,
    });
    const store = createBaseIndexStoreOperations();
    const scope = makeScopeMeta(workspace);
    const result = await engine.fullIndex(scope, [fixtureA, barrel, fixtureB, fixtureTypes], store);

    try {
      await runEnrichmentPass(result.index, customAnalyzer, { scopePath: workspace });
      expect(customAnalyzer.getCacheMaxSize()).toBe(7);
    } finally {
      customAnalyzer.dispose();
    }
  });

  it('skips calls edges to targets outside the index without error', async () => {
    expect(findSymbol(index, 'externalUtil')).toBeUndefined();

    const callerExec = findSymbol(index, 'exec', 'Caller');
    const outgoing = index.outgoing.get(callerExec!.symbol.id) ?? [];
    const callTargetIds = outgoing.filter((edge) => edge.kind === 'calls').map((edge) => edge.toSymbolId);
    const callTargetNames = callTargetIds.map((id) => index.symbolsById.get(id)?.symbol.name);
    expect(callTargetNames).not.toContain('externalUtil');

    for (const edges of index.outgoing.values()) {
      for (const edge of edges) {
        if (edge.kind === 'calls') {
          expect(index.symbolsById.has(edge.toSymbolId)).toBe(true);
          expect(index.symbolsById.has(edge.fromSymbolId)).toBe(true);
        }
      }
    }
  });
});

/**
 * Find a symbol record in the index by name and optional namespace path.
 * @param index - Scope index to search.
 * @param name - Symbol name.
 * @param namespacePath - Optional containing class name.
 * @returns Matching record or undefined.
 */
function findSymbol(index: ScopeIndexRecord, name: string, namespacePath?: string) {
  for (const record of index.symbolsById.values()) {
    if (record.symbol.name === name && (namespacePath === undefined || record.symbol.namespacePath === namespacePath)) {
      return record;
    }
  }
  return undefined;
}

/**
 * Find a symbol record by name and scope-relative file path.
 * @param index - Scope index to search.
 * @param name - Symbol name.
 * @param relativeFilePath - Scope-relative file path.
 * @returns Matching record or undefined.
 */
function findSymbolInFile(index: ScopeIndexRecord, name: string, relativeFilePath: string) {
  for (const record of index.symbolsById.values()) {
    if (record.symbol.name === name && record.relativeFilePath === relativeFilePath) {
      return record;
    }
  }
  return undefined;
}

/**
 * Create a non-TypeScript analyzer for enrichment capability tests.
 * @returns Minimal LanguageAnalyzer implementation.
 */
function createGenericAnalyzer(): LanguageAnalyzer {
  return {
    language: 'generic',
    extensions: ['.txt'],
    parseFile: async (): Promise<SymbolNode[]> => [],
    extractMembers: async (): Promise<MemberInfo[]> => [],
    extractDocSummary: async (): Promise<string | undefined> => undefined,
    findSymbolPosition: async (): Promise<{ line: number; column: number } | null> => null,
    dispose: (): void => undefined,
  };
}

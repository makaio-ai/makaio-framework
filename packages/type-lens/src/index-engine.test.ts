import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createBaseIndexStoreOperations,
  createTypeviewChangeBatch,
  DEFAULT_CONTINUITY_CONFIG,
  IndexEngine,
  TsciAnalyzer,
} from './index.js';
import type { ScopeMeta } from './index-types.js';
import { ENRICHMENT_VERSION } from './schemas.js';
import type { SymbolNode } from './schemas.js';
import type { FileCallEdge, LanguageAnalyzer } from './types.js';

function makeScopeMeta(scopePath: string): ScopeMeta {
  return {
    key: `main:${scopePath}`,
    type: 'cwd',
    path: scopePath,
    branch: 'main',
  };
}

const store = createBaseIndexStoreOperations();

class FailingAfterCallEdgesAnalyzer extends TsciAnalyzer {
  public override async resolveFileCallEdges(file: string): Promise<FileCallEdge[]> {
    return [
      {
        callerClassName: null,
        callerName: 'caller',
        callerDeclarationLine: 1,
        callLine: 2,
        target: {
          file,
          className: null,
          methodName: 'target',
          line: 5,
        },
      },
    ];
  }

  public override getCompilerProgram(): ReturnType<TsciAnalyzer['getCompilerProgram']> {
    throw new Error('fail after call edges mutate the enrichment scratch index');
  }
}

describe('IndexEngine', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typeview-core-index-engine-'));

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds an index from a core analyzer and store contract', async () => {
    const filePath = path.join(tempDir, 'ok.ts');
    fs.writeFileSync(filePath, 'export class Ok {}', 'utf8');

    const analyzer: LanguageAnalyzer = {
      language: 'typescript',
      extensions: ['.ts'],
      async parseFile(_filePath: string, relativeFilePath?: string): Promise<SymbolNode[]> {
        return [
          {
            id: '',
            name: 'Ok',
            kind: 'class',
            file: relativeFilePath ?? 'ok.ts',
            line: 1,
            isExported: true,
            signature: 'class Ok',
          },
        ];
      },
      async extractMembers() {
        return [];
      },
      async extractDocSummary() {
        return undefined;
      },
      async findSymbolPosition() {
        return null;
      },
      dispose() {},
    };

    const engine = new IndexEngine({ analyzer, continuityConfig: DEFAULT_CONTINUITY_CONFIG });
    const scope = makeScopeMeta(tempDir);
    const result = await engine.fullIndex(scope, [filePath], store);

    expect(result.index.symbolIdsByFile.get(filePath)).toHaveLength(1);
    expect([...result.index.symbolsById.values()][0]).toMatchObject({
      relativeFilePath: 'ok.ts',
      symbol: { name: 'Ok', kind: 'class' },
    });
  });

  it('returns the syntactic index when additive enrichment fails', async () => {
    const filePath = path.join(tempDir, 'syntax-only.ts');
    fs.writeFileSync(filePath, 'export class SyntaxOnly {}', 'utf8');

    const analyzer: LanguageAnalyzer = {
      language: 'typescript',
      extensions: ['.ts'],
      async parseFile(_filePath: string, relativeFilePath?: string): Promise<SymbolNode[]> {
        return [
          {
            id: '',
            name: 'SyntaxOnly',
            kind: 'class',
            file: relativeFilePath ?? 'syntax-only.ts',
            line: 1,
            isExported: true,
            signature: 'class SyntaxOnly',
          },
        ];
      },
      async extractMembers() {
        return [];
      },
      async extractDocSummary() {
        return undefined;
      },
      async findSymbolPosition() {
        return null;
      },
      dispose() {},
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const engine = new IndexEngine({ analyzer, continuityConfig: DEFAULT_CONTINUITY_CONFIG });
      const scope = makeScopeMeta(tempDir);
      const result = await engine.fullIndex(scope, [filePath], store, undefined, {
        enrichment: { scopePath: tempDir },
      });

      expect(result.index.symbolIdsByFile.get(filePath)).toHaveLength(1);
      expect([...result.index.symbolsById.values()][0].symbol.name).toBe('SyntaxOnly');
      expect(result.index.enrichment).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        '[IndexEngine] Semantic enrichment failed; returning syntactic index',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not leak partial enrichment mutations when enrichment fails after adding edges', async () => {
    const scopeDir = path.join(tempDir, 'partial-enrichment');
    fs.mkdirSync(scopeDir, { recursive: true });
    const filePath = path.join(scopeDir, 'calls.ts');
    fs.writeFileSync(
      filePath,
      `export function caller() {
  target();
}

export function target() {}
`,
      'utf8',
    );

    const analyzer = new FailingAfterCallEdgesAnalyzer();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const engine = new IndexEngine({ analyzer, continuityConfig: DEFAULT_CONTINUITY_CONFIG });
      const scope = makeScopeMeta(scopeDir);
      const result = await engine.fullIndex(scope, [filePath], store, undefined, {
        enrichment: { scopePath: scopeDir },
      });

      expect([...result.index.symbolsById.values()].map((record) => record.symbol.name).sort()).toEqual([
        'caller',
        'target',
      ]);
      expect(result.index.enrichment).toBeUndefined();
      expect(result.index.outgoing.size).toBe(0);
      expect(result.index.incoming.size).toBe(0);
      for (const record of result.index.symbolsById.values()) {
        expect(record.resolvedShape).toBeUndefined();
        expect(record.embeddableUnit).toBeUndefined();
      }
    } finally {
      warnSpy.mockRestore();
      analyzer.dispose();
    }
  });

  it('applies delete changes without parsing missing files', async () => {
    const filePath = path.join(tempDir, 'deleted.ts');
    const scope = makeScopeMeta(tempDir);
    const existing = store.createEmptyScopeIndex(scope);
    existing.symbolIdsByFile.set(filePath, ['deleted-symbol']);
    existing.symbolsById.set('deleted-symbol', {
      symbol: {
        id: 'deleted-symbol',
        name: 'Deleted',
        kind: 'class',
        file: 'deleted.ts',
        line: 1,
        isExported: true,
      },
      absoluteFilePath: filePath,
      relativeFilePath: 'deleted.ts',
      aliasHash: 'alias',
      semanticHash: 'semantic',
      originAliasHash: 'alias',
      nameLower: 'deleted',
      signatureLower: '',
    });
    existing.symbolIdByAliasHash.set('alias', 'deleted-symbol');

    const analyzer: LanguageAnalyzer = {
      language: 'typescript',
      extensions: ['.ts'],
      async parseFile(): Promise<SymbolNode[]> {
        throw new Error('delete changes must not parse');
      },
      async extractMembers() {
        return [];
      },
      async extractDocSummary() {
        return undefined;
      },
      async findSymbolPosition() {
        return null;
      },
      dispose() {},
    };

    const engine = new IndexEngine({ analyzer, continuityConfig: DEFAULT_CONTINUITY_CONFIG });
    const batch = createTypeviewChangeBatch(scope, [{ absolutePath: filePath, kind: 'delete' }]);
    const result = await engine.incrementalIndex(batch, store, existing);

    expect(result.index.symbolsById.has('deleted-symbol')).toBe(false);
    expect(result.index.symbolIdsByFile.has(filePath)).toBe(false);
  });

  it('preserves enrichment metadata when cloning base scope indexes', () => {
    const scope = makeScopeMeta(tempDir);
    const baseStore = createBaseIndexStoreOperations();
    const source = baseStore.createEmptyScopeIndex(scope);
    source.enrichment = { version: ENRICHMENT_VERSION, enrichedAt: 123 };

    const clone = baseStore.cloneScopeIndex(scope, source);

    expect(clone.enrichment).toEqual(source.enrichment);
    expect(clone.enrichment).not.toBe(source.enrichment);
  });

  it('rejects incremental batches for a different scope than the existing index', async () => {
    const scope = makeScopeMeta(tempDir);
    const existing = store.createEmptyScopeIndex(scope);
    const otherScope = makeScopeMeta(path.join(tempDir, 'other'));
    const analyzer: LanguageAnalyzer = {
      language: 'typescript',
      extensions: ['.ts'],
      async parseFile(): Promise<SymbolNode[]> {
        return [];
      },
      async extractMembers() {
        return [];
      },
      async extractDocSummary() {
        return undefined;
      },
      async findSymbolPosition() {
        return null;
      },
      dispose() {},
    };

    const engine = new IndexEngine({ analyzer, continuityConfig: DEFAULT_CONTINUITY_CONFIG });
    const batch = createTypeviewChangeBatch(otherScope, [
      { absolutePath: path.join(otherScope.path, 'file.ts'), kind: 'change' },
    ]);

    await expect(engine.incrementalIndex(batch, store, existing)).rejects.toThrow(/Scope mismatch/);
  });

  it('runs enrichment when the option is provided and leaves incremental untouched', async () => {
    const scopeDir = path.join(tempDir, 'enrich');
    fs.mkdirSync(scopeDir, { recursive: true });
    const filePath = path.join(scopeDir, 'svc.ts');
    fs.writeFileSync(filePath, 'export class Svc {}', 'utf8');

    const analyzer = new TsciAnalyzer();

    const engine = new IndexEngine({ analyzer, continuityConfig: DEFAULT_CONTINUITY_CONFIG });
    const scope = makeScopeMeta(scopeDir);
    const files = [filePath];

    try {
      const { index } = await engine.fullIndex(scope, files, store, undefined, {
        enrichment: { scopePath: scopeDir },
      });
      expect(index.enrichment?.version).toBe(ENRICHMENT_VERSION);

      const batch = createTypeviewChangeBatch(scope, [{ absolutePath: filePath, kind: 'change' }]);
      const { index: incremental } = await engine.incrementalIndex(batch, store, index);
      // Incremental never re-enriches; stamp is cleared so consumers can detect staleness.
      expect(incremental.enrichment).toBeUndefined();
    } finally {
      analyzer.dispose();
    }
  });
});

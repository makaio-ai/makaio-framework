import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTypeviewChangeBatch, DEFAULT_CONTINUITY_CONFIG, IndexEngine } from './index.js';
import type { ScopeIndexRecord, ScopeMeta } from './index-types.js';
import type { IndexStoreOperations } from './index-engine.js';
import type { SymbolNode } from './schemas.js';
import type { LanguageAnalyzer } from './types.js';

function makeScopeMeta(scopePath: string): ScopeMeta {
  return {
    key: `main:${scopePath}`,
    type: 'cwd',
    path: scopePath,
    branch: 'main',
  };
}

const store: IndexStoreOperations = {
  createEmptyScopeIndex(scope): ScopeIndexRecord {
    return {
      scope,
      indexedAt: Date.now(),
      symbolsById: new Map(),
      symbolIdsByFile: new Map(),
      symbolIdByAliasHash: new Map(),
      outgoing: new Map(),
      incoming: new Map(),
    };
  },
  cloneScopeIndex(scope, source): ScopeIndexRecord {
    return {
      scope,
      indexedAt: source.indexedAt,
      symbolsById: new Map(source.symbolsById),
      symbolIdsByFile: new Map(source.symbolIdsByFile),
      symbolIdByAliasHash: new Map(source.symbolIdByAliasHash),
      outgoing: new Map(source.outgoing),
      incoming: new Map(source.incoming),
    };
  },
  removeFile(index, filePath): void {
    const ids = index.symbolIdsByFile.get(filePath) ?? [];
    for (const id of ids) {
      const record = index.symbolsById.get(id);
      if (record) index.symbolIdByAliasHash.delete(record.aliasHash);
      index.symbolsById.delete(id);
      index.outgoing.delete(id);
      index.incoming.delete(id);
    }
    index.symbolIdsByFile.delete(filePath);
  },
  removeDirectory(index, directoryPath): void {
    const normalized = path.resolve(directoryPath);
    for (const filePath of [...index.symbolIdsByFile.keys()]) {
      if (filePath === normalized || filePath.startsWith(`${normalized}${path.sep}`)) {
        store.removeFile(index, filePath);
      }
    }
  },
};

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
});

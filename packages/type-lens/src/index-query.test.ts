import { describe, expect, it } from 'vitest';
import { resolveTraceRoot, searchIndex, traceGraph } from './index-query.js';
import type { IndexedSymbolRecord, ScopeIndexRecord } from './index-types.js';

function createIndex(records: IndexedSymbolRecord[]): ScopeIndexRecord {
  const symbolsById = new Map(records.map((record) => [record.symbol.id, record]));
  return {
    scope: { key: 'cwd:/workspace#main', type: 'cwd', path: '/workspace', branch: 'main' },
    indexedAt: 1,
    symbolsById,
    symbolIdsByFile: new Map(),
    symbolIdByAliasHash: new Map(records.map((record) => [record.aliasHash, record.symbol.id])),
    outgoing: new Map([['A', [{ fromSymbolId: 'A', toSymbolId: 'B', kind: 'extends' }]]]),
    incoming: new Map([['B', [{ fromSymbolId: 'A', toSymbolId: 'B', kind: 'extends' }]]]),
  };
}

function record(id: string, name: string, relativeFilePath: string, line: number): IndexedSymbolRecord {
  return {
    symbol: {
      id,
      name,
      kind: 'class',
      file: relativeFilePath,
      line,
      isExported: true,
    },
    absoluteFilePath: `/workspace/${relativeFilePath}`,
    relativeFilePath,
    aliasHash: `alias-${id}`,
    semanticHash: `semantic-${id}`,
    originAliasHash: `alias-${id}`,
    nameLower: name.toLowerCase(),
    signatureLower: '',
  };
}

describe('index query helpers', () => {
  it('resolves trace roots from file-qualified symbol references', () => {
    const index = createIndex([record('A', 'Alpha', 'src/a.ts', 1), record('B', 'Beta', 'src/b.ts', 2)]);

    expect(resolveTraceRoot(index, 'src/a.ts#Alpha')).toBe('A');
  });

  it('traces outgoing graph edges from a root symbol', () => {
    const index = createIndex([record('A', 'Alpha', 'src/a.ts', 1), record('B', 'Beta', 'src/b.ts', 2)]);

    const result = traceGraph(index, 'A', 'outgoing', 1);

    expect(result.nodes.map((node) => node.symbolId).sort()).toEqual(['A', 'B']);
    expect(result.edges).toEqual([{ fromSymbolId: 'A', toSymbolId: 'B', kind: 'extends' }]);
  });

  it('deduplicates repeated semantic provider matches', async () => {
    const index = createIndex([record('A', 'Alpha', 'src/a.ts', 1)]);

    const result = await searchIndex(
      index,
      { query: 'semantic' },
      {
        async search() {
          return [
            { symbolId: 'A', score: 0.9 },
            { symbolId: 'A', score: 0.8 },
          ];
        },
      },
    );

    expect(result.map((match) => match.symbolId)).toEqual(['A']);
  });
});

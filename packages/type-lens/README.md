# @makaio/type-lens

TypeScript codebase indexing and analysis engine for the Makaio framework.
Parses TypeScript source files with `ts-morph`, extracts typed symbol records
(classes, interfaces, functions, enums, type aliases), builds a dependency-
edge graph, and provides keyword + semantic search over the resulting index.
Used to give AI agents deep, up-to-date understanding of a workspace's type
surface.

## Usage

### Build an index with `IndexEngine`

```typescript
import { IndexEngine, createBaseIndexStoreOperations } from '@makaio/type-lens';

const store = createBaseIndexStoreOperations(db); // seam — provide your own storage
const engine = new IndexEngine({
  store,
  rootPath: '/workspace',
  branch: 'main',
});

await engine.indexAll(); // full initial index
await engine.applyBatch(changeBatch); // incremental update
```

### Search the index

```typescript
import { searchIndex, traceGraph } from '@makaio/type-lens';

const matches = await searchIndex(store, {
  query: 'SessionOrchestrator',
  rootPath: '/workspace',
  branch: 'main',
  limit: 10,
});

const graph = await traceGraph(store, {
  symbolId: 'abc123',
  direction: 'outgoing',
  depth: 3,
});
```

### Analyze a single file with `TsciAnalyzer`

```typescript
import { TsciAnalyzer } from '@makaio/type-lens';

const analyzer = new TsciAnalyzer({ tsConfigFilePath: '/workspace/tsconfig.json' });
const symbols = await analyzer.parseFile('/workspace/src/session.ts');
// symbols: SymbolNode[] with kind, name, members, position, etc.
analyzer.dispose();
```

### Analyze type shapes with `TypeAnalyzer`

```typescript
import { TypeAnalyzer } from '@makaio/type-lens';

const ta = new TypeAnalyzer({ tsConfigFilePath: '/workspace/tsconfig.json' });
const shape = await ta.analyzeType('IMakaioSession', '/workspace/src/session.ts');
// shape.properties: ResolvedTypeProperty[]
ta.dispose();
```

## API Overview

| Export | Description |
|--------|-------------|
| `IndexEngine` | Full indexing pipeline: parse, extract, diff, persist symbol and edge records |
| `createBaseIndexStoreOperations()` | Base in-memory `IndexStoreOperations` implementation |
| `createAliasHash()` | Compute a stable branch-scoped SHA-1 symbol identity hash |
| `TsciAnalyzer` | `ts-morph` backed language analyzer implementing `LanguageAnalyzer` |
| `TypeAnalyzer` | Resolves a named type to its property shape using the TypeScript type checker |
| `searchIndex()` | Keyword search with optional semantic re-ranking |
| `traceGraph()` | Traverse the dependency-edge graph from a symbol |
| `matchesPathPrefix()` / `resolveTraceRoot()` | Path helpers for graph traversal |
| `extractClasses()` / `extractInterfaces()` / `extractFunctions()` / `extractEnums()` / `extractTypeAliases()` | Direct `ts-morph` symbol extractors |
| `extractMembers()` / `extractExecutableMembers()` / `extractDocSummary()` | Member-level detail extractors |
| `findDeclaration()` / `findMethodNode()` | Declaration lookup helpers |
| `getClassHierarchy()` / `getInterfaceHierarchy()` | Inheritance chain resolution |
| `createTypeviewChangeBatch()` | Build an incremental `TypeviewChangeBatch` from file change events |
| `createSymbolId()` / `generateId()` | Stable and random ID generation |
| `resolveSymbolIdentity()` / `claimContinuitySymbols()` | Symbol continuity across file renames |
| `HashEmbeddingProvider` | Deterministic hash-based embedding provider (no ML dependency) |
| `cosineSimilarity()` / `toEmbeddingBlob()` / `toFloat32Array()` | Vector math utilities |
| `shouldIndexTypeviewSourceFile()` / `createTypeviewSourceGlobIgnorePatterns()` | Source-file filter helpers |
| All schema types | `SymbolNode`, `SymbolKind`, `SymbolDetail`, `MemberInfo`, `DescribeFileRequest/Response`, `DescribeSymbolRequest/Response` |
| `type LanguageAnalyzer` | Seam interface for plugging in non-TypeScript language analyzers |

## Sub-path Exports

The package exposes granular sub-paths for selective imports:

| Sub-path | Contents |
|----------|---------|
| `./index-engine` | `IndexEngine` and store operations |
| `./index-query` | `searchIndex`, `traceGraph`, search types |
| `./index-types` | Low-level storage record types |
| `./index-utils` | Path and comparison utilities |
| `./member-extractor` | Member extraction from `ts-morph` nodes |
| `./source-filter` | Source file inclusion/exclusion helpers |
| `./symbol-extractor` | Top-level symbol extractors |
| `./type-analysis` | `TypeAnalyzer` and resolved type shapes |
| `./tsci-analyzer` | `TsciAnalyzer` |
| `./schemas` | Zod schemas |
| `./storage/vector-math` | Cosine similarity and Float32 encoding |

## Installation

`@makaio/type-lens` is a private workspace package:

```json
{ "@makaio/type-lens": "workspace:*" }
```

---

*Part of the [Makaio AI Framework](../../README.md)*

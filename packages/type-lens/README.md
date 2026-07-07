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

const ta = new TypeAnalyzer({
  entryPoints: ['/workspace/src/session.ts'],
  tsconfigPath: '/workspace/tsconfig.json',
});
const analysis = ta.analyzeDeclarationAt('/workspace/src/session.ts', 'IMakaioSession');
// analysis.resolvedShape: ResolvedTypeShape (flattened property table)
// analysis.composition: TypeCompositionNode (how the type is constructed)
```

### Run the enrichment pass

After building a syntactic index with `IndexEngine`, the optional **enrichment
pass** layers checker-backed semantic data onto the existing index records:

```typescript
import { runEnrichmentPass } from '@makaio/type-lens';

await runEnrichmentPass(index, analyzer, {
  scopePath: '/workspace',
});
```

The enrichment pass mutates the index in place and produces:

- **`calls` edges** — Checker-resolved call-graph edges attributed to their
  containing declaration (method, function, or arrow variable). These appear in
  `index.outgoing` / `index.incoming` alongside the existing `extends` /
  `implements` edges.
- **Re-resolved heritage edges** — Existing regex-derived `extends` /
  `implements` edges are replaced with checker-resolved ones that follow
  the full alias chain.
- **Resolved type shapes** — Exported `type` and `interface` symbols receive a
  `resolvedShape` field (`ResolvedTypeShape`) containing the flattened property
  table after following all composition (Omit, Pick, intersection, extension).
  Shapes exceeding the property limit are recorded as `{ kind: 'omitted' }`.
- **Embeddable units** — Every symbol receives a canonical, deterministic text
  representation (`EmbeddableUnit`) designed for embedding. The text is
  assembled in a fixed order (header, signature, doc, shape, body excerpt) with
  no timestamps or absolute paths so identical source always produces identical
  text. Each unit carries a `version` stamp (`ENRICHMENT_VERSION`) that changes
  only when the generation logic changes.

#### Opt-in contract

Enrichment is opt-in: pass `options.enrichment` to `IndexEngine.fullIndex()`.
Incremental indexes (`incrementalIndex`) clear the enrichment stamp to signal
that re-enrichment is needed.

#### Determinism guarantee

Embeddable unit text is deterministic: given the same source file content and
compiler configuration, the same text is produced regardless of execution
environment or wall-clock time. This allows stable embedding vector comparison
across index runs.

## API Overview

| Export | Description |
|--------|-------------|
| `IndexEngine` | Full indexing pipeline: parse, extract, diff, persist symbol and edge records |
| `createBaseIndexStoreOperations()` | Base in-memory `IndexStoreOperations` implementation |
| `createAliasHash()` | Compute a stable branch-scoped SHA-1 symbol identity hash |
| `TsciAnalyzer` | `ts-morph` backed language analyzer implementing `LanguageAnalyzer` |
| `TypeAnalyzer` | Resolves a named type to its property shape using the TypeScript type checker |
| `runEnrichmentPass()` | Semantic enrichment over a syntactic index: call edges, heritage re-resolution, resolved shapes, embeddable units |
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
| `./enrichment-pass` | `runEnrichmentPass` and `EnrichmentOptions` |
| `./storage/vector-math` | Cosine similarity and Float32 encoding |

## Installation

`@makaio/type-lens` is a private workspace package:

```json
{ "@makaio/type-lens": "workspace:*" }
```

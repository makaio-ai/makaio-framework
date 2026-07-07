import * as path from 'node:path';
import ts from 'typescript';
import { ENRICHMENT_VERSION } from './schemas.js';
import type { EmbeddableUnit, ResolvedTypeShape } from './schemas.js';
import type { EdgeRelation, IndexEdgeRecord, IndexedSymbolRecord, ScopeIndexRecord } from './index-types.js';
import { appendEdge } from './index-helpers.js';
import type { FileCallEdge, LanguageAnalyzer } from './types.js';
import { TypeAnalyzer, asCompilerProgram } from './type-analysis.js';
import { TsciAnalyzer } from './tsci-analyzer.js';

// ============================================================
// Public contract
// ============================================================

/** Options controlling the semantic enrichment pass. */
export interface EnrichmentOptions {
  /** Workspace root used for call-target eligibility filtering. */
  scopePath: string;
  /** Optional package allowlist forwarded to call resolution. */
  includePackages?: string[];
  /** Cap forwarded to resolved-shape extraction. Default 40. */
  maxShapeProperties?: number;
}

/** Maximum body excerpt lines before truncation in embeddable units. */
const MAX_BODY_EXCERPT_LINES = 40;
/** Number of records processed between macrotask yields in semantic passes. */
const ENRICHMENT_YIELD_INTERVAL = 100;

// ============================================================
// Symbol lookup table
// ============================================================

/**
 * Build a lookup key for a symbol from its relative file path, namespace path,
 * and name. This key is used to match call-edge targets and heritage-clause
 * targets back to indexed symbols.
 * @param relativeFilePath - Scope-relative file path.
 * @param namespacePath - Containing class name or undefined for top-level.
 * @param name - Symbol name.
 * @returns Pipe-delimited lookup key.
 */
function buildLookupKey(relativeFilePath: string, namespacePath: string | undefined, name: string): string {
  return `${relativeFilePath}|${namespacePath ?? ''}|${name}`;
}

/**
 * Build a Map from lookup keys to symbol records for fast target resolution.
 * @param index - The scope index to scan.
 * @returns Map from lookup key to candidate symbol records.
 */
function buildSymbolLookupTable(index: ScopeIndexRecord): Map<string, IndexedSymbolRecord[]> {
  const table = new Map<string, IndexedSymbolRecord[]>();
  for (const record of index.symbolsById.values()) {
    const key = buildLookupKey(record.relativeFilePath, record.symbol.namespacePath, record.symbol.name);
    const bucket = table.get(key) ?? [];
    bucket.push(record);
    table.set(key, bucket);
  }
  return table;
}

// ============================================================
// Call edges
// ============================================================

/**
 * Convert an absolute file path to a scope-relative path for lookup table matching.
 * @param absoluteFilePath - Absolute file path.
 * @param scopePath - Workspace root.
 * @returns Scope-relative file path.
 */
function toRelativePath(absoluteFilePath: string, scopePath: string): string {
  return path.relative(scopePath, absoluteFilePath);
}

/**
 * Process call edges for a single file and append them to the index.
 *
 * Uses the analyzer's `resolveFileCallEdges` to discover outgoing calls, maps
 * caller and target through the symbol lookup table, deduplicates, and
 * populates `index.outgoing` / `index.incoming`.
 * @param index - The scope index to mutate.
 * @param absoluteFilePath - Absolute path of the file to scan.
 * @param scopePath - Workspace root for call-target filtering.
 * @param analyzer - Language analyzer with `resolveFileCallEdges` capability.
 * @param lookupTable - Symbol lookup table for target resolution.
 * @param edgeSeen - Set of already-seen edge keys for deduplication.
 * @param includePackages - Optional package allowlist.
 */
async function processFileCallEdges(
  index: ScopeIndexRecord,
  absoluteFilePath: string,
  scopePath: string,
  analyzer: LanguageAnalyzer,
  lookupTable: Map<string, IndexedSymbolRecord[]>,
  edgeSeen: Set<string>,
  includePackages?: string[],
): Promise<void> {
  if (!analyzer.resolveFileCallEdges) return;

  const edges: FileCallEdge[] = await analyzer.resolveFileCallEdges(absoluteFilePath, scopePath, includePackages);

  const callerRelPath = toRelativePath(absoluteFilePath, scopePath);

  for (const edge of edges) {
    if (!edge.callerName) continue;
    const fromSymbolId = resolveSymbolId(
      callerRelPath,
      edge.callerClassName,
      edge.callerName,
      lookupTable,
      edge.callerDeclarationLine,
    );
    if (!fromSymbolId) continue;

    const targetRelPath = toRelativePath(edge.target.file, scopePath);
    const toSymbolId = resolveSymbolId(
      targetRelPath,
      edge.target.className,
      edge.target.methodName,
      lookupTable,
      edge.target.line,
    );
    if (!toSymbolId) continue;

    // Skip self-edges.
    if (fromSymbolId === toSymbolId) continue;

    const edgeKey = `${fromSymbolId}->${toSymbolId}:calls`;
    if (edgeSeen.has(edgeKey)) continue;
    edgeSeen.add(edgeKey);

    const edgeRecord: IndexEdgeRecord = {
      fromSymbolId,
      toSymbolId,
      kind: 'calls',
    };
    appendEdge(index.outgoing, index.incoming, edgeRecord);
  }
}

/**
 * Resolve a symbol to its ID in the lookup table by file path, optional
 * class name (as namespace path), and symbol name.
 * @param relPath - Scope-relative file path.
 * @param className - Containing class name, or null for top-level.
 * @param name - Symbol name.
 * @param lookupTable - Symbol lookup table.
 * @param declarationLine - Optional 1-based declaration line to disambiguate
 *   checker-resolved local declarations from indexed top-level symbols with the
 *   same file/class/name identity.
 * @returns Symbol ID or undefined if not found in the index.
 */
function resolveSymbolId(
  relPath: string,
  className: string | null,
  name: string,
  lookupTable: Map<string, IndexedSymbolRecord[]>,
  declarationLine?: number,
): string | undefined {
  const key = buildLookupKey(relPath, className ?? undefined, name);
  const candidates = lookupTable.get(key);
  if (!candidates || candidates.length === 0) return undefined;
  if (declarationLine !== undefined) {
    return candidates.find((record) => record.symbol.line === declarationLine)?.symbol.id;
  }
  return candidates[0].symbol.id;
}

// ============================================================
// Heritage re-resolution
// ============================================================

/**
 * Re-resolve heritage edges for all class and interface symbols using the
 * TypeScript checker, replacing the regex-derived edges from `rebuildGraph`.
 *
 * For each class/interface symbol, resolves heritage clause types via the
 * checker to their canonical declaration (following alias chains). Maps
 * targets through the symbol lookup table. Removes existing `extends` and
 * `implements` outgoing edges (and their incoming mirrors) before inserting
 * the checker-resolved ones.
 * @param index - The scope index to mutate.
 * @param compilerProgram - TypeScript compiler program for checker access.
 * @param lookupTable - Symbol lookup table for target resolution.
 * @param scopePath - Workspace root for relative-path computation.
 */
async function reResolveHeritage(
  index: ScopeIndexRecord,
  compilerProgram: ts.Program,
  lookupTable: Map<string, IndexedSymbolRecord[]>,
  scopePath: string,
): Promise<void> {
  const checker = compilerProgram.getTypeChecker();
  let processed = 0;

  for (const [symbolId, record] of index.symbolsById) {
    const { kind } = record.symbol;
    if (kind !== 'class' && kind !== 'interface') continue;

    const sourceFile = compilerProgram.getSourceFile(path.resolve(record.absoluteFilePath));
    if (!sourceFile) continue;

    const declaration = findNamedDeclaration(sourceFile, record.symbol.name, kind);
    if (!declaration) continue;

    // Remove existing extends/implements outgoing edges and their incoming mirrors.
    removeHeritageEdges(index, symbolId);

    // Resolve heritage clauses via the checker.
    const heritageClauses = declaration.heritageClauses ?? [];
    const seen = new Set<string>();

    for (const clause of heritageClauses) {
      const relation: EdgeRelation = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';

      for (const heritageType of clause.types) {
        const targetId = resolveHeritageTarget(checker, heritageType, lookupTable, scopePath);
        if (!targetId) continue;
        if (targetId === symbolId) continue; // skip self

        const edgeKey = `${symbolId}->${targetId}:${relation}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);

        appendEdge(index.outgoing, index.incoming, {
          fromSymbolId: symbolId,
          toSymbolId: targetId,
          kind: relation,
        });
      }
    }

    processed++;
    if (processed % ENRICHMENT_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
}

/**
 * Find a named class or interface declaration in a source file.
 *
 * Only searches top-level statements — nested declarations (e.g. classes
 * inside functions) are not considered, consistent with the symbol-extractor
 * scope which only indexes top-level and class-member symbols.
 * @param sourceFile - TypeScript source file.
 * @param name - Declaration name to find.
 * @param kind - Symbol kind ('class' or 'interface').
 * @returns The declaration node or undefined.
 */
function findNamedDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
  kind: 'class' | 'interface',
): ts.ClassDeclaration | ts.InterfaceDeclaration | undefined {
  const isTarget = kind === 'class' ? ts.isClassDeclaration : ts.isInterfaceDeclaration;
  for (const statement of sourceFile.statements) {
    if (isTarget(statement) && (statement as ts.NamedDeclaration).name?.getText() === name) {
      return statement as ts.ClassDeclaration | ts.InterfaceDeclaration;
    }
  }
  return undefined;
}

/**
 * Resolve a single heritage type expression to a symbol ID in the lookup table.
 *
 * Follows the TypeScript alias chain to the canonical declaration, then maps
 * the declaration file and name through the lookup table.
 * @param checker - TypeScript type checker.
 * @param heritageType - Heritage clause type expression.
 * @param lookupTable - Symbol lookup table.
 * @param scopePath - Workspace root for relative-path computation.
 * @returns Symbol ID or undefined if the target is not in the index.
 */
function resolveHeritageTarget(
  checker: ts.TypeChecker,
  heritageType: ts.ExpressionWithTypeArguments,
  lookupTable: Map<string, IndexedSymbolRecord[]>,
  scopePath: string,
): string | undefined {
  try {
    const symbol = checker.getSymbolAtLocation(heritageType.expression);
    if (!symbol) return undefined;

    // Follow alias chain to canonical declaration.
    const resolved = resolveAliasChain(checker, symbol);
    const declarations = resolved.getDeclarations?.();
    if (!declarations || declarations.length === 0) return undefined;

    const declaration = declarations[0];
    const targetFile = declaration.getSourceFile().fileName;
    const targetRelPath = toRelativePath(targetFile, scopePath);
    const targetName = getDeclarationLookupName(declaration, resolved.getName());

    // Top-level type — no namespace path.
    return resolveSymbolId(targetRelPath, null, targetName, lookupTable, sourceFileLineStart(declaration));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the lookup name used by the syntactic index for a declaration.
 * @param declaration - Declaration resolved by the checker.
 * @param fallbackName - Symbol name reported by TypeScript.
 * @returns Declaration name when available, otherwise the symbol fallback name.
 */
function getDeclarationLookupName(declaration: ts.Declaration, fallbackName: string): string {
  const declarationName = (declaration as ts.NamedDeclaration).name;
  if (!declarationName) return fallbackName;
  return declarationName.getText(declaration.getSourceFile());
}

/**
 * Return the 1-based start line for a declaration.
 * @param declaration - TypeScript declaration node.
 * @returns Declaration start line number.
 */
function sourceFileLineStart(declaration: ts.Declaration): number {
  const sourceFile = declaration.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
}

/**
 * Follow the TypeScript alias chain to the canonical symbol.
 * @param checker - TypeScript type checker.
 * @param symbol - Symbol to resolve.
 * @returns Canonical symbol after alias resolution.
 */
function resolveAliasChain(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  const visited = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !visited.has(current)) {
    visited.add(current);
    try {
      const aliased = checker.getAliasedSymbol(current);
      if (!aliased || aliased === current) break;
      current = aliased;
    } catch {
      break;
    }
  }
  return current;
}

/**
 * Remove all `extends` and `implements` outgoing edges for a symbol, including
 * their mirrored incoming edges on the target side.
 * @param index - The scope index to mutate.
 * @param symbolId - Symbol whose heritage edges should be removed.
 */
function removeHeritageEdges(index: ScopeIndexRecord, symbolId: string): void {
  const outgoing = index.outgoing.get(symbolId);
  if (!outgoing) return;

  // Single-pass partition into heritage and remaining edges.
  const heritageEdges: IndexEdgeRecord[] = [];
  const remaining: IndexEdgeRecord[] = [];
  for (const edge of outgoing) {
    if (edge.kind === 'extends' || edge.kind === 'implements') {
      heritageEdges.push(edge);
    } else {
      remaining.push(edge);
    }
  }

  // Remove incoming mirrors.
  for (const edge of heritageEdges) {
    const incoming = index.incoming.get(edge.toSymbolId);
    if (incoming) {
      const filtered = incoming.filter(
        (e) => !(e.fromSymbolId === symbolId && (e.kind === 'extends' || e.kind === 'implements')),
      );
      if (filtered.length > 0) {
        index.incoming.set(edge.toSymbolId, filtered);
      } else {
        index.incoming.delete(edge.toSymbolId);
      }
    }
  }

  // Replace outgoing with non-heritage edges only.
  if (remaining.length > 0) {
    index.outgoing.set(symbolId, remaining);
  } else {
    index.outgoing.delete(symbolId);
  }
}

// ============================================================
// Resolved shapes
// ============================================================

/**
 * Attach resolved type shapes to exported type alias and interface symbols.
 * @param index - The scope index to mutate.
 * @param typeAnalyzer - TypeAnalyzer instance for shape resolution.
 */
async function attachResolvedShapes(index: ScopeIndexRecord, typeAnalyzer: TypeAnalyzer): Promise<void> {
  let processed = 0;
  for (const record of index.symbolsById.values()) {
    const { kind, isExported, name } = record.symbol;
    if (!isExported || (kind !== 'type' && kind !== 'interface')) {
      processed++;
      if (processed % ENRICHMENT_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
      continue;
    }

    const analysis = typeAnalyzer.analyzeDeclarationAt(record.absoluteFilePath, name);
    if (analysis?.resolvedShape) {
      record.resolvedShape = analysis.resolvedShape;
    }
    processed++;
    if (processed % ENRICHMENT_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
}

// ============================================================
// Embeddable units
// ============================================================

/**
 * Assemble a deterministic embeddable unit text for a symbol record.
 *
 * The text is assembled in a fixed order with no timestamps or absolute paths:
 * 1. `kind name` header
 * 2. Signature (if present)
 * 3. Doc summary (if available)
 * 4. Rendered resolved shape (if present)
 * 5. Body excerpt for function/method symbols (truncated to 40 lines)
 * @param record - Indexed symbol record.
 * @param docSummary - JSDoc summary text, or undefined.
 * @param bodyExcerpt - Function/method body text, or undefined.
 * @returns Deterministic text for embedding.
 */
function assembleEmbeddableText(
  record: IndexedSymbolRecord,
  docSummary: string | undefined,
  bodyExcerpt: string | undefined,
): string {
  const parts: string[] = [];

  // 1. Header: kind + qualified name in relative file context.
  // For method symbols, prefix with the containing class/namespace so
  // the embedding captures the full identity (e.g. "method Svc.run").
  const qualifiedName = record.symbol.namespacePath
    ? `${record.symbol.namespacePath}.${record.symbol.name}`
    : record.symbol.name;
  parts.push(`${record.symbol.kind} ${qualifiedName}`);
  parts.push(`file: ${record.relativeFilePath}`);

  // 2. Signature.
  if (record.symbol.signature) {
    parts.push(`signature: ${record.symbol.signature}`);
  }

  // 3. Doc summary.
  if (docSummary) {
    parts.push(`doc: ${docSummary}`);
  }

  // 4. Resolved shape.
  if (record.resolvedShape) {
    parts.push(renderResolvedShape(record.resolvedShape));
  }

  // 5. Body excerpt (functions and methods only).
  if (bodyExcerpt) {
    parts.push(`body:\n${bodyExcerpt}`);
  }

  return parts.join('\n');
}

/**
 * Render a resolved type shape to a compact text representation.
 * @param shape - Resolved type shape.
 * @returns Human-readable shape text.
 */
function renderResolvedShape(shape: ResolvedTypeShape): string {
  if (shape.kind === 'omitted') {
    return `shape: (omitted: ${shape.reason})`;
  }
  const props = shape.properties.map((p) => `  ${p.name}${p.optional ? '?' : ''}: ${p.type}`).join('\n');
  return `shape: {\n${props}\n}`;
}

/**
 * Truncate a body string to a maximum number of lines, appending a marker
 * when truncated.
 * @param body - Raw body text.
 * @param maxLines - Maximum number of lines to keep.
 * @returns Truncated body text.
 */
function truncateBody(body: string, maxLines: number): string {
  const lines = body.split('\n');
  if (lines.length <= maxLines) return body;
  return `${lines.slice(0, maxLines).join('\n')}\n…`;
}

/**
 * Attach embeddable units to all symbols in the index.
 * @param index - The scope index to mutate.
 * @param analyzer - Language analyzer for doc and body extraction.
 */
async function attachEmbeddableUnits(index: ScopeIndexRecord, analyzer: LanguageAnalyzer): Promise<void> {
  let processed = 0;
  for (const record of index.symbolsById.values()) {
    const { kind, name } = record.symbol;

    // Extract doc summary and body excerpt concurrently — they are independent.
    const docPromise = analyzer
      .extractDocSummary(record.absoluteFilePath, name, kind, record.symbol.namespacePath ?? null)
      .catch(() => undefined as string | undefined);

    const needsBody = (kind === 'function' || kind === 'method') && analyzer.extractMethodBody;
    const bodyPromise = needsBody
      ? analyzer.extractMethodBody!(record.absoluteFilePath, record.symbol.namespacePath ?? null, name)
          .then((result) => (result ? truncateBody(result.body, MAX_BODY_EXCERPT_LINES) : undefined))
          .catch(() => undefined as string | undefined)
      : Promise.resolve(undefined as string | undefined);

    const [docSummary, bodyExcerpt] = await Promise.all([docPromise, bodyPromise]);

    const text = assembleEmbeddableText(record, docSummary, bodyExcerpt);
    const unit: EmbeddableUnit = {
      version: ENRICHMENT_VERSION,
      text,
    };
    record.embeddableUnit = unit;
    processed++;
    if (processed % ENRICHMENT_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }
}

// ============================================================
// Event-loop yielding
// ============================================================

/**
 * Yield control to the event loop to prevent starvation during CPU-heavy passes.
 * @returns Promise that resolves on the next event loop iteration.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ============================================================
// Main orchestrator
// ============================================================

/**
 * Semantic enrichment over a fully built syntactic index. Mutates the index in
 * place: adds checker-resolved 'calls' edges, replaces regex-derived heritage
 * edges with checker-resolved ones, attaches resolved shapes and embeddable
 * units to symbol records, and stamps the index with the enrichment version.
 * @param index - The scope index produced by a full index run.
 * @param analyzer - TypeScript analyzer that owns the shared compiler program.
 * @param options - Scope and budget configuration.
 */
export async function runEnrichmentPass(
  index: ScopeIndexRecord,
  analyzer: LanguageAnalyzer,
  options: EnrichmentOptions,
): Promise<void> {
  const { scopePath, includePackages, maxShapeProperties } = options;
  if (!(analyzer instanceof TsciAnalyzer)) {
    throw new Error('Semantic enrichment requires TsciAnalyzer so all checker-backed outputs share one program.');
  }

  // --- Program setup ---
  // Resize cache to hold all files, touch every indexed file so the Project
  // holds the full scope, then restore the caller's original cache size in finally.
  const fileCount = index.symbolIdsByFile.size;
  const originalCacheMaxSize = analyzer.getCacheMaxSize();
  if (fileCount > 0) {
    analyzer.resizeCache(Math.max(originalCacheMaxSize, fileCount));
  }

  try {
    // Touch every indexed file so the checker has full scope.
    let touched = 0;
    for (const absoluteFilePath of index.symbolIdsByFile.keys()) {
      analyzer.touchFile(absoluteFilePath);
      touched++;
      if (touched % ENRICHMENT_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    // Build symbol lookup table.
    const lookupTable = buildSymbolLookupTable(index);

    // --- Call edges ---
    const edgeSeen = new Set<string>();
    // Seed the seen set with existing edges to prevent duplicates.
    for (const edges of index.outgoing.values()) {
      for (const edge of edges) {
        edgeSeen.add(`${edge.fromSymbolId}->${edge.toSymbolId}:${edge.kind}`);
      }
    }

    for (const absoluteFilePath of index.symbolIdsByFile.keys()) {
      await processFileCallEdges(index, absoluteFilePath, scopePath, analyzer, lookupTable, edgeSeen, includePackages);
      await yieldToEventLoop();
    }

    // --- Heritage re-resolution and resolved shapes ---
    // Use the shared ts-morph compiler program so heritage re-resolution and
    // type-shape extraction honour the workspace's tsconfig (path aliases,
    // baseUrl, strict settings, etc.).  TypeAnalyzer.fromProgram accepts the
    // structural CompilerProgramLike interface, bridging the nominal type gap
    // between @ts-morph/common's re-declared TypeScript namespace and the
    // typescript package's own types.
    const compilerProgram = asCompilerProgram(analyzer.getCompilerProgram());
    await reResolveHeritage(index, compilerProgram, lookupTable, scopePath);

    const typeAnalyzer = TypeAnalyzer.fromProgram(compilerProgram, {
      maxShapeProperties: maxShapeProperties ?? 40,
    });
    await attachResolvedShapes(index, typeAnalyzer);

    // --- Embeddable units ---
    await attachEmbeddableUnits(index, analyzer);

    // --- Stamp ---
    index.enrichment = {
      version: ENRICHMENT_VERSION,
      enrichedAt: Date.now(),
    };
  } finally {
    if (fileCount > 0) {
      analyzer.resizeCache(originalCacheMaxSize);
    }
  }
}

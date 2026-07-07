import { z } from 'zod';

/**
 * Symbol kinds supported by TypeView.
 * SEAM: Add 'variable' and 'namespace' when extraction is implemented.
 */
export const SymbolKindSchema = z.enum(['class', 'interface', 'function', 'type', 'enum', 'method']);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

/**
 * A symbol extracted from source code.
 */
export const SymbolNodeSchema = z.object({
  /** Unique identifier, stable within a scope and branch. Incorporates namespacePath for member symbols. */
  id: z.string(),
  /** Symbol name */
  name: z.string(),
  /** Symbol kind */
  kind: SymbolKindSchema,
  /** File path (relative to workspace) */
  file: z.string(),
  /** Line number (1-indexed) */
  line: z.number(),
  /** Whether exported */
  isExported: z.boolean(),
  /** Signature string (e.g., "class Foo implements IBar") */
  signature: z.string().optional(),
  /**
   * Container-qualified owner path. Top-level symbols: undefined. Class members: class name
   * (e.g., `'MyService'`). Future nested: dot-joined (e.g., `'Outer.Inner'`).
   *
   * Invariant: always set when kind='method' (enforced by extractExecutableMembers,
   * not by schema, to preserve ZodObject composability).
   */
  namespacePath: z.string().optional(),
});
export type SymbolNode = z.infer<typeof SymbolNodeSchema>;

/**
 * Member info for classes/interfaces.
 */
export const MemberInfoSchema = z.object({
  name: z.string(),
  type: z.string(),
  line: z.number(),
});
export type MemberInfo = z.infer<typeof MemberInfoSchema>;

/**
 * Detailed symbol information.
 */
export const SymbolDetailSchema = z.object({
  symbol: SymbolNodeSchema,
  /** Members (for class/interface) */
  members: z.array(MemberInfoSchema).optional(),
  /** JSDoc summary */
  docSummary: z.string().optional(),
  /** Token estimate for context budgeting */
  tokenEstimate: z.number(),
});
export type SymbolDetail = z.infer<typeof SymbolDetailSchema>;

// ============================================================
// Request/Response Schemas
// ============================================================

/**
 * describe_symbol: Get detailed info about a specific symbol.
 */
export const DescribeSymbolRequestSchema = z.object({
  /** Absolute file path */
  file: z.string(),
  /** Symbol name */
  name: z.string(),
  /** Optional kind filter */
  kind: SymbolKindSchema.optional(),
});
export type DescribeSymbolRequest = z.infer<typeof DescribeSymbolRequestSchema>;

export const DescribeSymbolResponseSchema = z.object({
  detail: SymbolDetailSchema.nullable(),
});
export type DescribeSymbolResponse = z.infer<typeof DescribeSymbolResponseSchema>;

/**
 * describe_file: List all symbols in a file.
 */
export const DescribeFileRequestSchema = z.object({
  /** Absolute file path */
  file: z.string(),
});
export type DescribeFileRequest = z.infer<typeof DescribeFileRequestSchema>;

export const DescribeFileResponseSchema = z.object({
  symbols: z.array(SymbolNodeSchema),
  /** Token estimate for context budgeting */
  tokenEstimate: z.number(),
});
export type DescribeFileResponse = z.infer<typeof DescribeFileResponseSchema>;

// ============================================================
// Enrichment Schemas
// ============================================================

/** Version stamp for enrichment output semantics. Bump when edge/shape/unit generation logic changes. */
export const ENRICHMENT_VERSION = 'v1';

/** Property entry within a checker-resolved object shape. */
export const ResolvedTypePropertySchema = z.object({
  /** Property name in the resolved object shape. */
  name: z.string(),
  /** Rendered TypeScript type for the property. */
  type: z.string(),
  /** Whether the property remains optional after type resolution. */
  optional: z.boolean(),
});
export type ResolvedTypeProperty = z.infer<typeof ResolvedTypePropertySchema>;

/** Checker-resolved type shape: either a concrete object or an omitted placeholder. */
export const ResolvedTypeShapeSchema = z.discriminatedUnion('kind', [
  z.object({
    /** Discriminator for a fully resolved object shape. */
    kind: z.literal('object'),
    /** Resolved property list. */
    properties: z.array(ResolvedTypePropertySchema),
  }),
  z.object({
    /** Discriminator for an omitted shape. */
    kind: z.literal('omitted'),
    /** Human-readable explanation for why the shape was omitted. */
    reason: z.string(),
  }),
]);
export type ResolvedTypeShape = z.infer<typeof ResolvedTypeShapeSchema>;

/** Canonical, deterministic text representation of a symbol for embedding. */
export const EmbeddableUnitSchema = z.object({
  /** Enrichment format version the text was generated under. */
  version: z.string(),
  /** Canonical, deterministic text representation of the symbol for embedding. */
  text: z.string(),
});
export type EmbeddableUnit = z.infer<typeof EmbeddableUnitSchema>;

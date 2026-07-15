import { z } from 'zod';

import { JsonValueSchema } from '../shared/json-value.js';

/* -------------------------------------------------------------------------- */
/*  View level                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Closed set of artifact view detail levels.
 *
 * Levels order monotonically: `link < summary < full`. A field declared at
 * `link` is available at every level; a field declared at `full` appears only
 * when the full view is requested.
 */
export const ArtifactViewLevelSchema = z.enum(['link', 'summary', 'full']);

/** Artifact view detail level. */
export type ArtifactViewLevel = z.infer<typeof ArtifactViewLevelSchema>;

/* -------------------------------------------------------------------------- */
/*  Provider-neutral link / navigation record                                 */
/* -------------------------------------------------------------------------- */

/**
 * A provider-neutral navigation link.
 *
 * Links may reference a framework artifact by its stable id, an external URL,
 * or both. At least one locator (`artifactId` or `url`) should be present for
 * the link to be useful, but the schema does not enforce exclusivity — both
 * may coexist when an artifact has a known external counterpart.
 * @param artifactId - Stable framework artifact identity (open string).
 * @param url - External deep-link URL.
 * @param label - Human-readable label for the link.
 */
export const ArtifactViewLinkSchema = z.object({
  /** Stable framework artifact identity (open string). */
  artifactId: z.string().min(1).optional(),
  /** External deep-link URL. */
  url: z.string().min(1).optional(),
  /** Human-readable label for the link. */
  label: z.string().min(1),
});

/** A provider-neutral navigation link. */
export type ArtifactViewLink = z.infer<typeof ArtifactViewLinkSchema>;

/* -------------------------------------------------------------------------- */
/*  Section schemas — eight discriminants                                     */
/* -------------------------------------------------------------------------- */

/**
 * Summary section: a short prose description.
 * @param type - Section discriminant. Always `'summary'`.
 * @param title - Human-readable section heading.
 * @param text - Plain-text summary content.
 */
export const ArtifactViewSummarySectionSchema = z.object({
  /** Section discriminant. */
  type: z.literal('summary'),
  /** Human-readable section heading. */
  title: z.string().min(1),
  /** Plain-text summary content. */
  text: z.string().min(1),
});

/**
 * Properties section: key-value metadata rows.
 * @param type - Section discriminant. Always `'properties'`.
 * @param title - Human-readable section heading.
 * @param rows - Ordered key-value pairs.
 */
export const ArtifactViewPropertiesSectionSchema = z.object({
  /** Section discriminant. */
  type: z.literal('properties'),
  /** Human-readable section heading. */
  title: z.string().min(1),
  /** Ordered key-value pairs. */
  rows: z.array(
    z.object({
      /** Row label (e.g. `'Status'`). */
      label: z.string().min(1),
      /** Row value (e.g. `'Active'`). */
      value: z.string(),
    }),
  ),
});

/**
 * Table section: columnar data with optional row-level links.
 * @param type - Section discriminant. Always `'table'`.
 * @param title - Human-readable section heading.
 * @param columns - Column header labels.
 * @param rows - Table rows; each row carries an array of cell values and an
 *   optional link that may reference a framework artifact or an external URL.
 */
export const ArtifactViewTableSectionSchema = z.object({
  /** Section discriminant. */
  type: z.literal('table'),
  /** Human-readable section heading. */
  title: z.string().min(1),
  /** Column header labels. */
  columns: z.array(z.string().min(1)),
  /** Table rows. */
  rows: z.array(
    z.object({
      /** Cell values, one per column. */
      cells: z.array(z.string()),
      /** Optional row-level navigation link. */
      link: ArtifactViewLinkSchema.optional(),
    }),
  ),
});

/**
 * Relations section: grouped relation items with open type strings.
 *
 * Relation types remain open strings so that product-owned kinds and
 * extensions can declare custom relation semantics without modifying
 * the framework contract.
 * @param type - Section discriminant. Always `'relations'`.
 * @param title - Human-readable section heading.
 * @param groups - Grouped relation items, each group keyed by an open relation
 *   type string.
 */
export const ArtifactViewRelationsSectionSchema = z.object({
  /** Section discriminant. */
  type: z.literal('relations'),
  /** Human-readable section heading. */
  title: z.string().min(1),
  /** Grouped relation items. */
  groups: z.array(
    z.object({
      /** Open relation type string (e.g. `'depends-on'`, `'blocks'`). */
      type: z.string().min(1),
      /** Relation items in this group. */
      items: z.array(ArtifactViewLinkSchema),
    }),
  ),
});

/**
 * Evidence section: references to external evidence sources.
 * @param type - Section discriminant. Always `'evidence'`.
 * @param title - Human-readable section heading.
 * @param items - Evidence items; `kind` and `id` are open strings to allow
 *   product-defined evidence categories.
 */
export const ArtifactViewEvidenceSectionSchema = z.object({
  /** Section discriminant. */
  type: z.literal('evidence'),
  /** Human-readable section heading. */
  title: z.string().min(1),
  /** Evidence items. */
  items: z.array(
    z.object({
      /** Evidence kind (e.g. `'commit'`, `'file'`, `'url'`). Open string. */
      kind: z.string().min(1),
      /** Stable evidence identifier within its kind. */
      id: z.string().min(1),
      /** Optional locator within the evidence (e.g. a line range). */
      locator: z.string().min(1).optional(),
    }),
  ),
});

/**
 * Raw section: opaque JSON-safe data for inspection or debugging.
 *
 * The `json` field is validated recursively against the JSON value contract
 * to ensure the view model remains serializable.
 * @param type - Section discriminant. Always `'raw'`.
 * @param title - Human-readable section heading.
 * @param json - Arbitrary JSON-safe value.
 */
export const ArtifactViewRawSectionSchema = z.object({
  /** Section discriminant. */
  type: z.literal('raw'),
  /** Human-readable section heading. */
  title: z.string().min(1),
  /** Arbitrary JSON-safe value. */
  json: JsonValueSchema,
});

/**
 * Code section: source code or structured text with a language hint.
 * @param type - Section discriminant. Always `'code'`.
 * @param title - Human-readable section heading.
 * @param language - Language identifier (e.g. `'typescript'`, `'go'`). Open string.
 * @param content - Source code content.
 */
export const ArtifactViewCodeSectionSchema = z.object({
  /** Section discriminant. */
  type: z.literal('code'),
  /** Human-readable section heading. */
  title: z.string().min(1),
  /** Language identifier (e.g. `'typescript'`, `'go'`). Open string. */
  language: z.string().min(1),
  /** Source code content. */
  content: z.string(),
});

/**
 * Diagram section: structured diagram source with a notation identifier.
 *
 * Currently only `'mermaid'` is supported as a notation, but the field is
 * a literal to allow future additions through a discriminated union.
 * @param type - Section discriminant. Always `'diagram'`.
 * @param title - Human-readable section heading.
 * @param notation - Diagram notation identifier. Currently only `'mermaid'`.
 * @param source - Diagram source text.
 */
export const ArtifactViewDiagramSectionSchema = z.object({
  /** Section discriminant. */
  type: z.literal('diagram'),
  /** Human-readable section heading. */
  title: z.string().min(1),
  /** Diagram notation identifier. */
  notation: z.literal('mermaid'),
  /** Diagram source text. */
  source: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/*  Section union                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Discriminated union of all artifact view section variants.
 *
 * The `type` field is the discriminant. Each variant carries its own typed
 * payload; see the individual section schemas for details.
 */
export const ArtifactViewSectionSchema = z.discriminatedUnion('type', [
  ArtifactViewSummarySectionSchema,
  ArtifactViewPropertiesSectionSchema,
  ArtifactViewTableSectionSchema,
  ArtifactViewRelationsSectionSchema,
  ArtifactViewEvidenceSectionSchema,
  ArtifactViewRawSectionSchema,
  ArtifactViewCodeSectionSchema,
  ArtifactViewDiagramSectionSchema,
]);

/** Any artifact view section variant. */
export type ArtifactViewSection = z.infer<typeof ArtifactViewSectionSchema>;

/** Summary section. */
export type ArtifactViewSummarySection = z.infer<typeof ArtifactViewSummarySectionSchema>;

/** Properties section. */
export type ArtifactViewPropertiesSection = z.infer<typeof ArtifactViewPropertiesSectionSchema>;

/** Table section. */
export type ArtifactViewTableSection = z.infer<typeof ArtifactViewTableSectionSchema>;

/** Relations section. */
export type ArtifactViewRelationsSection = z.infer<typeof ArtifactViewRelationsSectionSchema>;

/** Evidence section. */
export type ArtifactViewEvidenceSection = z.infer<typeof ArtifactViewEvidenceSectionSchema>;

/** Raw section. */
export type ArtifactViewRawSection = z.infer<typeof ArtifactViewRawSectionSchema>;

/** Code section. */
export type ArtifactViewCodeSection = z.infer<typeof ArtifactViewCodeSectionSchema>;

/** Diagram section. */
export type ArtifactViewDiagramSection = z.infer<typeof ArtifactViewDiagramSectionSchema>;

/* -------------------------------------------------------------------------- */
/*  ArtifactViewModelSchema                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Provider-neutral artifact view model.
 *
 * Contains semantic content and navigation, not Markdown, provider-specific
 * field names, or renderer-specific layout directives. The model is
 * JSON-safe: every value in every section must survive a JSON round-trip.
 * @param title - Human-readable title for the artifact view.
 * @param summary - Optional prose summary.
 * @param navigation - Optional ordered set of navigation links.
 * @param sections - Ordered array of typed sections.
 */
export const ArtifactViewModelSchema = z.object({
  /** Human-readable title for the artifact view. */
  title: z.string().min(1),
  /** Optional prose summary of the artifact. */
  summary: z.string().min(1).optional(),
  /** Optional ordered set of navigation links. */
  navigation: z.array(ArtifactViewLinkSchema).optional(),
  /** Ordered array of typed sections. */
  sections: z.array(ArtifactViewSectionSchema),
});

/** Provider-neutral artifact view model. */
export type ArtifactViewModel = z.infer<typeof ArtifactViewModelSchema>;

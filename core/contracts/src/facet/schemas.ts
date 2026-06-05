import { z } from 'zod';

/**
 * Authority actors permitted to assert or modify a facet value.
 *
 * - `'human'` — end-user acting through the UI or a client tool
 * - `'system'` — runtime infrastructure (e.g., lifecycle rules)
 * - `'agent'` — an AI or automated agent operating in a session
 */
export const FacetAuthoritySchema = z.enum(['human', 'system', 'agent']);

/**
 * Cardinality of values a facet namespace permits per target.
 *
 * - `'single'` — at most one value active at a time (e.g., a status field)
 * - `'multiple'` — several values may coexist (e.g., labels or tags)
 */
export const FacetCardinalitySchema = z.enum(['single', 'multiple']);

/**
 * Entity classes that a facet namespace may be applied to.
 *
 * - `'workpiece'` — a top-level unit of work (e.g., a task or session)
 * - `'artifact'` — a versioned framework artifact revision
 * - `'surface'` — a UI surface or layout area
 */
export const FacetAppliesToSchema = z.enum(['workpiece', 'artifact', 'surface']);

/**
 * Serializable registration record for a named facet namespace.
 *
 * Facet namespace registrations are declared by framework services and product
 * extensions, then consumed by the facet service to validate and route facet
 * assertions. The `namespace` field is a kebab-case identifier unique within
 * the facet registry.
 */
export const FacetNamespaceRegistrationSchema = z.object({
  /**
   * Unique namespace identifier.
   * Must start with a lowercase letter followed by lowercase letters, digits,
   * or hyphens (e.g., `'status'`, `'review-state'`).
   */
  namespace: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/),
  /** Cardinality policy — how many values may be active simultaneously. */
  cardinality: FacetCardinalitySchema,
  /**
   * Permitted facet values, or `'open'` to allow any string.
   *
   * When an array is provided the facet service validates assertions against
   * this set. When `'open'`, any non-empty string is accepted.
   */
  values: z.union([z.literal('open'), z.array(z.string().min(1)).readonly()]),
  /**
   * Authority actors allowed to assert this facet.
   * At least one entry is required.
   */
  authority: z.array(FacetAuthoritySchema).min(1).readonly(),
  /**
   * Entity classes this facet may be applied to.
   * At least one entry is required.
   */
  appliesTo: z.array(FacetAppliesToSchema).min(1).readonly(),
  /** Optional human-readable description of the facet namespace. */
  description: z.string().min(1).optional(),
});

/** Serializable registration record for a named facet namespace. */
export type FacetNamespaceRegistration = z.infer<typeof FacetNamespaceRegistrationSchema>;

/** Authority actor permitted to assert or modify a facet value. */
export type FacetAuthority = z.infer<typeof FacetAuthoritySchema>;

/** Cardinality policy for a facet namespace. */
export type FacetCardinality = z.infer<typeof FacetCardinalitySchema>;

/** Entity class a facet namespace may be applied to. */
export type FacetAppliesTo = z.infer<typeof FacetAppliesToSchema>;

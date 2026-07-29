import { z } from 'zod';

import type { ResolvedArtifactContextWire } from '../artifact/context-resolution.js';
import type { ArtifactRelation, ArtifactRevision } from '../artifact/schemas.js';
import { JsonObjectContractSchema } from '../shared/json-value.js';
import type { ArtifactViewLevel, ArtifactViewNavigation, ArtifactViewSection } from './view-model.js';
import { ArtifactViewLevelSchema } from './view-model.js';

/* -------------------------------------------------------------------------- */
/*  Declaration-mergeable params registry                                     */
/* -------------------------------------------------------------------------- */

/**
 * Empty interface intended for declaration merging.
 *
 * Extension or product code augments this interface to register provider- or
 * kind-specific view parameter shapes:
 *
 * ```ts
 * declare module '@makaio/contracts' {
 *   interface ArtifactViewParamsMap {
 *     'my-kind': { depth: number; includeArchived: boolean };
 *   }
 * }
 * ```
 *
 * A builder's literal `kind` selects its corresponding shape through
 * {@link ArtifactViewParamsFor}. Unregistered kinds remain open so artifact
 * kinds never need central registration before they can be rendered.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ArtifactViewParamsMap {}

/**
 * Resolve the authoring params for an artifact kind.
 *
 * Registered literal kinds receive their declaration-merged shape only when
 * it is object-shaped. Arrays and functions are not valid parameter objects,
 * so invalid registrations resolve to `never`; every other string receives
 * the same open JSON-object-shaped type used by the runtime request schema.
 * @typeParam K - Artifact kind handled by the builder.
 */
export type ArtifactViewParamsFor<K extends string> = K extends keyof ArtifactViewParamsMap
  ? ArtifactViewParamsMap[K] extends object
    ? ArtifactViewParamsMap[K] extends readonly unknown[]
      ? never
      : ArtifactViewParamsMap[K] extends (...args: never[]) => unknown
        ? never
        : ArtifactViewParamsMap[K]
    : never
  : Readonly<Record<string, unknown>>;

/**
 * Runtime artifact view params schema.
 *
 * Validates that params are JSON-safe objects. The runtime schema is always
 * {@link JsonObjectContractSchema}: requests cross process boundaries and must
 * accept arbitrary artifact kinds without depending on declaration merging.
 */
export const ArtifactViewParamsSchema = JsonObjectContractSchema;

/* -------------------------------------------------------------------------- */
/*  View request                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A request for an artifact view at a specific detail level.
 *
 * The same schema is used by surface bindings, resolver requests, and builder
 * context — no parallel parameter types.
 * @param level - Requested detail level (`link`, `summary`, or `full`).
 * @param params - Optional JSON-safe runtime parameters.
 */
export const ArtifactViewRequestSchema = z.object({
  /** Requested detail level. */
  level: ArtifactViewLevelSchema,
  /** Optional JSON-safe runtime parameters. */
  params: ArtifactViewParamsSchema.optional(),
});

/** A request for an artifact view at a specific detail level. */
export type ArtifactViewRequest = z.infer<typeof ArtifactViewRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Entry affordance structural base                                          */
/* -------------------------------------------------------------------------- */

/**
 * Shared structural fields for the `entry` affordance variants.
 *
 * Both the declaration and the request variant carry the same container
 * selectors; the declaration additionally extends this base with the
 * declaration-policy `title` field.
 */
const EntryAffordanceBaseSchema = z.object({
  /** Affordance kind discriminant. */
  kind: z.literal('entry'),
  /**
   * Container identifier that hosts this entry.
   * Exactly one of `via` or `collection` must be present.
   */
  via: z.string().min(1).optional(),
  /**
   * Collection identifier that hosts this entry.
   * Exactly one of `via` or `collection` must be present.
   */
  collection: z.string().min(1).optional(),
});

/**
 * Create the "exactly one of `via` or `collection`" refinement shared by the
 * entry affordance declaration and request variants.
 * @param subject - Noun used in the issue message (`'affordance'` for
 *   declarations, `'request'` for requests).
 * @returns A `superRefine` callback for entry affordance objects.
 */
function requireExactlyOneEntryTarget(subject: 'affordance' | 'request') {
  return (val: { via?: string; collection?: string }, ctx: z.RefinementCtx): void => {
    const hasVia = val.via !== undefined;
    const hasCollection = val.collection !== undefined;
    if (hasVia === hasCollection) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Entry ${subject} must have exactly one of via or collection`,
      });
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Affordance declarations                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Affordance declaration for artifact view rendering.
 *
 * Affordances are exact and authoritative when present. Each variant declares
 * where and how an artifact kind may be rendered:
 *
 * - `'own-view'` — the artifact has its own full view (always at `full` level).
 * - `'inline'` — the artifact may be inlined within a host artifact's view,
 *   keyed by the host relation type. The optional `as` field is declaration
 *   policy controlling the inline level; callers never supply it.
 * - `'entry'` — the artifact may appear as an entry in a container (dashboard,
 *   collection). Exactly one of `via` or `collection` must be present. The
 *   optional `title` is declaration policy. The container caller selects
 *   `request.level`; there is no separate entry-level property.
 *
 * Multiple entry declarations are legal.
 */
export const ArtifactViewAffordanceDeclarationSchema = z.discriminatedUnion('kind', [
  z.object({
    /** Affordance kind discriminant. */
    kind: z.literal('own-view'),
  }),
  z.object({
    /** Affordance kind discriminant. */
    kind: z.literal('inline'),
    /** Host relation type that triggers inlining. */
    hostRelation: z.string().min(1),
    /**
     * Declaration-level override for the inline detail level.
     * Omitted `as` resolves as `full` during generic resolution.
     */
    as: ArtifactViewLevelSchema.optional(),
  }),
  EntryAffordanceBaseSchema.extend({
    /** Optional display title for the entry (declaration policy, not caller-controlled). */
    title: z.string().min(1).optional(),
    /**
     * Relation type a host-scoped collection container traverses from an
     * entry member back to the host artifact that owns the collection.
     *
     * Like `title` and inline's `as`, this is declaration policy — it tells
     * the container how to resolve its host, not the caller how to select
     * the affordance. Requests keep selecting by `via`/`collection` only,
     * and the matcher stays untouched.
     */
    hostRelation: z.string().min(1).optional(),
  }).superRefine(requireExactlyOneEntryTarget('affordance')),
]);

/** Affordance declaration for artifact view rendering. */
export type ArtifactViewAffordanceDeclaration = z.infer<typeof ArtifactViewAffordanceDeclarationSchema>;

/* -------------------------------------------------------------------------- */
/*  Affordance requests                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Structural selector for requesting an artifact view through an affordance.
 *
 * Requests use only structural selectors — declaration-policy fields (`as`,
 * `title`) are stripped. The container caller selects the detail level via
 * the resolve request's top-level `level`, not on the affordance itself.
 *
 * - `'own-view'` — request the artifact's own full view.
 * - `'inline'` + `hostRelation` — request an inline view keyed by relation.
 * - `'entry'` + (`via` | `collection`) — request an entry view.
 */
export const ArtifactViewAffordanceRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    /** Affordance kind discriminant. */
    kind: z.literal('own-view'),
  }),
  z.object({
    /** Affordance kind discriminant. */
    kind: z.literal('inline'),
    /** Host relation type that triggers inlining. */
    hostRelation: z.string().min(1),
  }),
  EntryAffordanceBaseSchema.superRefine(requireExactlyOneEntryTarget('request')),
]);

/** Structural selector for requesting an artifact view through an affordance. */
export type ArtifactViewAffordanceRequest = z.infer<typeof ArtifactViewAffordanceRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Live artifact view builder contract                                       */
/* -------------------------------------------------------------------------- */

/**
 * Context supplied to an {@link ArtifactViewBuilder}'s `build` method.
 *
 * Contains the resolved artifact, the requested view parameters, the
 * deterministic generic sections produced by the framework, and the
 * direct relations already present on the artifact. The context is
 * readonly — builders compose their output from it without side effects.
 *
 * Deliberately excludes provider IDs, raw storage handles, `find`
 * helpers, and bus transport concerns. Builders operate on fully
 * resolved snapshots.
 */
export interface ArtifactViewBuilderContext<K extends string = string> {
  /** The fully resolved artifact revision. */
  readonly artifact: ArtifactRevision;
  /** Requested view detail level. */
  readonly level: ArtifactViewLevel;
  /** Structural affordance selector for the view. */
  readonly affordance: ArtifactViewAffordanceRequest;
  /** Optional JSON-safe runtime parameters. */
  readonly params: ArtifactViewParamsFor<K> | undefined;
  /**
   * Deterministic generic sections produced by the framework's generic
   * builder for this artifact, level, and kind registration.
   *
   * Builders may compose from these sections when they want to augment
   * rather than fully replace the generic projection.
   */
  readonly genericSections: readonly ArtifactViewSection[];
  /**
   * Deterministic navigation produced from direct artifact relations.
   *
   * Builders may compose from this value when adding kind-specific
   * breadcrumbs or replacing generic related links.
   */
  readonly genericNavigation: ArtifactViewNavigation;
  /** Direct relations already present on the artifact revision. */
  readonly relations: readonly ArtifactRelation[];
  /**
   * The context graph resolved from the kind registration's declared
   * `defaultContext` selector via `ArtifactSubjects.resolveContext`.
   *
   * Present only when the kind registration declares a `defaultContext`
   * selector AND context resolution succeeded (the resolve-context RPC
   * was handled). `undefined` when the registration declares no selector
   * or no resolver handled the request.
   */
  readonly defaultContext: ResolvedArtifactContextWire | undefined;
}

/**
 * Builder output for a single artifact view.
 *
 * Outcomes:
 * - `undefined` — keep generic sections and navigation unchanged.
 * - `{ sections }`, `{ navigation }`, or both — replace each supplied
 *   generic value completely. Builders compose explicitly from
 *   `context.genericSections` or `context.genericNavigation` to augment it.
 * - `{ render: false }` — suppress rendering entirely. The resolver
 *   produces a `not-rendered` result.
 */
export type ArtifactViewBuilderResult =
  | undefined
  | {
      readonly sections: readonly ArtifactViewSection[];
      readonly navigation?: ArtifactViewNavigation;
    }
  | {
      readonly sections?: readonly ArtifactViewSection[];
      readonly navigation: ArtifactViewNavigation;
    }
  | { readonly render: false };

/**
 * Live artifact view builder registration.
 *
 * Builders match an exact `kind + schemaVersion` pair and carry a
 * positive monotonic version. Only one active builder per key is
 * allowed; collisions across owners are hard errors.
 *
 * Builder functions are live extension contributions and must not cross
 * the bus. Only serializable requests and responses travel over the bus;
 * the builder registry is an in-process construct.
 */
export interface ArtifactViewBuilder<K extends string = string> {
  /** Exact artifact kind this builder handles. */
  readonly kind: K;
  /** Exact schema version this builder handles. */
  readonly schemaVersion: string;
  /**
   * Positive monotonic version of this builder.
   *
   * Used by the resolve protocol's `builderVersion` field. Must be a
   * positive integer.
   */
  readonly version: number;
  /**
   * Build an artifact view for the given context.
   * @param context - Fully resolved builder context.
   * @returns Builder result, or a promise that resolves to one.
   */
  build(context: ArtifactViewBuilderContext<K>): Promise<ArtifactViewBuilderResult>;
}

/**
 * Define a live artifact view builder while preserving its literal kind for
 * declaration-merged {@link ArtifactViewParamsFor} inference.
 *
 * Contributions erase builders to `ArtifactViewBuilder<string>` when they
 * enter the runtime registry. Define builders first so their `build` context
 * remains correlated with the literal `kind` at the authoring boundary.
 * @typeParam K - Literal artifact kind handled by the builder.
 * @param builder - Builder registration with a literal artifact kind.
 * @returns The same builder with its kind-specific context retained.
 */
export function defineArtifactViewBuilder<const K extends string>(
  builder: ArtifactViewBuilder<K>,
): ArtifactViewBuilder<K> {
  return builder;
}

/**
 * Executable artifact view builders contribution declared by an
 * extension package.
 *
 * The `createBuilders` factory is called during extension activation and
 * must return the set of builder registrations to install. Returning a
 * `Promise` allows async resource acquisition (e.g. lazy loading).
 */
export interface ExtensionArtifactViewBuildersContribution {
  /**
   * Factory that produces the builder registrations for this extension.
   *
   * Called once during extension activation. The returned builders are
   * registered with the artifact view builder registry under the
   * extension's owner key, replacing any previous set.
   * @returns Builder registrations or a promise resolving to them.
   */
  readonly createBuilders: () => readonly ArtifactViewBuilder[] | Promise<readonly ArtifactViewBuilder[]>;
}

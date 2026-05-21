import type { MakaioBusContext } from './bus.js';
import type { BusSubjects, FlatSubjectDefinitions } from '../utils/subject-transformation.js';
import type { ScopedBus } from '../scoped-bus.js';
import type { SubjectRecord, SubjectSchema } from '@makaio/core';

/**
 * A registered bus namespace with domain, subjects, and pre-computed filter payload type.
 * @typeParam Domain - The namespace domain string (e.g., 'adapter:codex-mcp')
 * @typeParam Subjects - The subject record mapping subject keys to payload types
 * @typeParam FilterPayload - Pre-computed intersection of all filterable payloads for type-safe withFilter
 * @typeParam Schemas - The original schema record; drives narrow literal types on subjects.$meta (e.g., local: false)
 */
export type BusNamespace<
  Domain extends string = string,
  Subjects extends SubjectRecord | BusSubjects = SubjectRecord,
  FilterPayload = unknown,
  Schemas extends Record<string, SubjectSchema> = Record<string, SubjectSchema>,
> = {
  name: Domain;
  subjects: BusSubjects<FlatSubjectDefinitions<Domain, Schemas>, Domain>;

  scopedBus(context?: MakaioBusContext): Promise<ScopedBus<Domain, Subjects, FilterPayload>>;

  /**
   * Phantom property for type extraction. Never accessed at runtime.
   * Enables `ExtractFilterPayload<T>` to infer the FilterPayload type parameter
   * without relying on complex nested generic inference.
   */
  readonly __filterPayload?: FilterPayload;
};

/**
 * Extract the Domain type parameter from a BusNamespace.
 */
export type ExtractNamespaceDomain<T> = T extends BusNamespace<infer D, infer _S, infer _F, infer _Sc> ? D : string;

/**
 * Extract the Subjects type parameter from a BusNamespace.
 */
export type ExtractNamespaceSubjects<T> =
  T extends BusNamespace<infer _D, infer S, infer _F, infer _Sc> ? S : SubjectRecord;

/**
 * Extract the FilterPayload type parameter from a BusNamespace.
 * Uses the phantom `__filterPayload` property for reliable extraction.
 */
export type ExtractFilterPayload<T> = T extends { __filterPayload?: infer F } ? Exclude<F, undefined> : unknown;

/**
 * Derive a ScopedBus type from a BusNamespace, preserving Domain, Subjects, and FilterPayload.
 * @example
 * ```typescript
 * const MyNamespace = MakaioBus.registerNamespace('myDomain', { ... });
 * export type MyBus = ScopedBusFor<typeof MyNamespace>;
 * // Equivalent to: ScopedBus<'myDomain', { ...subjects... }, FilterPayload>
 * ```
 */
export type ScopedBusFor<T> =
  T extends BusNamespace<infer D, infer S, infer F, infer _Sc>
    ? ScopedBus<D, S extends SubjectRecord ? S : SubjectRecord, F>
    : never;

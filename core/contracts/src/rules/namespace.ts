import { createBusNamespace, journalSubject, localSubject, type SchemaRecord } from '@makaio/core';
import { EvaluationSettledSchema } from './evaluation-settled.js';
import { RulesEvaluationsRequestSchema, RulesEvaluationsResponseSchema } from './evaluation.js';
import {
  LookupCatalogRequestSchema,
  LookupCatalogResponseSchema,
  ReactionCatalogRequestSchema,
  ReactionCatalogResponseSchema,
  TriggerCatalogRequestSchema,
  TriggerCatalogResponseSchema,
} from './catalog.js';
import { RulesReprocessRequestSchema, RulesReprocessResponseSchema } from './reprocess.js';

/**
 * Bus schemas of the rule evaluation.
 *
 * - `evaluations` reads an occasion's evaluation, or a page of evaluations of one rule, read-only. It is local to the
 *   host process because the facts of an occasion carry the full origin, including claims.
 * - `reprocess` sets a failed evaluation, with its failed parts, back to pending.
 * - `evaluation-settled` is a volatile hint for observers, for every final state of an evaluation; no rule may name it.
 * - `triggers`, `reactions`, `lookups` are the three catalogs, derived from the registries and the active extensions' contributions.
 */
export const RulesSchemas = {
  evaluations: localSubject({ request: RulesEvaluationsRequestSchema, response: RulesEvaluationsResponseSchema }),
  reprocess: { request: RulesReprocessRequestSchema, response: RulesReprocessResponseSchema },
  'evaluation-settled': journalSubject(EvaluationSettledSchema, { retention: 'volatile' }),
  triggers: {
    request: TriggerCatalogRequestSchema,
    response: TriggerCatalogResponseSchema,
  },
  reactions: { request: ReactionCatalogRequestSchema, response: ReactionCatalogResponseSchema },
  lookups: {
    request: LookupCatalogRequestSchema,
    response: LookupCatalogResponseSchema,
  },
} satisfies SchemaRecord;

/** Rules bus namespace, domain `makaio:rules`. */
export const RulesNamespace = createBusNamespace('makaio:rules', RulesSchemas);

/** Typed subjects of the rules, for `bus.request()` and `bus.on()`. */
export const RulesSubjects = RulesNamespace.subjects;

import { createBusNamespace } from '@makaio/core';
import type { SchemaRecord } from '@makaio/core';
import {
  ContextRuleChangedEventSchema,
  ContextRuleResolutionRequestSchema,
  ResolvedContextRulesSchema,
} from './schemas.js';

const ContextRulesServiceSchemas = {
  /**
   * Resolve matching context rules for the current runtime snapshot.
   */
  resolve: {
    request: ContextRuleResolutionRequestSchema,
    response: ResolvedContextRulesSchema,
  },

  /**
   * Lifecycle event emitted whenever persisted context rules change.
   */
  changed: ContextRuleChangedEventSchema,
} satisfies SchemaRecord;

/**
 * Registered service namespace for context-rule resolution and invalidation.
 */
export const ContextRulesServiceNamespace = createBusNamespace('contextRules', ContextRulesServiceSchemas);

/**
 * Typed subjects for the context-rules service namespace.
 */
export const ContextRulesServiceSubjects = ContextRulesServiceNamespace.subjects;

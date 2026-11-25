import { defineDialectSchema } from '@makaio/storage-drizzle';
import * as sqlite from './schema.js';
import * as postgres from './schema.postgres.js';

/** Dialect variants for durable rule state. */
export const ruleStorageSchema = defineDialectSchema(
  {
    ruleCauses: sqlite.ruleCauses,
    ruleEvaluations: sqlite.ruleEvaluations,
    ruleEvaluationParts: sqlite.ruleEvaluationParts,
  },
  postgres,
);

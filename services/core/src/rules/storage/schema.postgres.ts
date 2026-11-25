import { ruleCausesDual, ruleEvaluationPartsDual, ruleEvaluationsDual } from './schema.js';

/** PostgreSQL causes schema. */
export const ruleCauses = ruleCausesDual.postgres;
/** PostgreSQL evaluations schema. */
export const ruleEvaluations = ruleEvaluationsDual.postgres;
/** PostgreSQL parts schema. */
export const ruleEvaluationParts = ruleEvaluationPartsDual.postgres;

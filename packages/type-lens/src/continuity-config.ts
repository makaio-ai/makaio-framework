/**
 * Tunable thresholds and weights for symbol continuity scoring.
 */
export interface ContinuityConfig {
  /** Minimum composite score to treat as the same symbol. Default 0.72. */
  readonly sameSymbolThreshold: number;
  /** Minimum composite score to record a lineage relation. Default 0.45. */
  readonly lineageThreshold: number;
  /** Weight of semantic signature similarity. Default 0.8. */
  readonly semanticWeight: number;
  /** Weight of file-path similarity. Default 0.2. */
  readonly pathWeight: number;
}

/**
 * Algorithm version stamp embedded in lineage rows.
 * Increment when scoring logic changes.
 */
export const CONTINUITY_ALGORITHM_VERSION = 'v1';

/**
 * Default continuity configuration values.
 */
export const DEFAULT_CONTINUITY_CONFIG: ContinuityConfig = {
  sameSymbolThreshold: 0.72,
  lineageThreshold: 0.45,
  semanticWeight: 0.8,
  pathWeight: 0.2,
};

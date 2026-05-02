/**
 * Extension point for UI scope identifiers.
 *
 * Hosts and extensions add host-specific scopes via declaration
 * merging. Framework defaults stay host-agnostic.
 */
export interface UiScopeMap {
  /** Available in framework-global contexts. */
  global: true;
  /** Available regardless of active UI context. */
  any: true;
}

/** UI scope identifier, extensible via {@link UiScopeMap}. */
export type UiScope = keyof UiScopeMap & string;

/**
 * Extension point for UI navigation levels.
 *
 * Hosts add domain levels through declaration merging.
 */
export interface UiNavigationLevelMap {
  /** Root shell level with no host context implied. */
  root: true;
  /** Available at every registered navigation level. */
  any: true;
}

/** UI navigation level, extensible via {@link UiNavigationLevelMap}. */
export type UiNavigationLevel = keyof UiNavigationLevelMap & string;

/**
 * Runtime UI navigation level.
 *
 * Runtime context snapshots describe the active renderer surface. The `'any'`
 * level is reserved for definition matching and is never an active navigation
 * level.
 */
export type UiRuntimeNavigationLevel = Exclude<UiNavigationLevel, 'any'>;

/**
 * Extension point for typed UI context values.
 *
 * Keys are context dimensions; values are the serializable values exposed for
 * that dimension in a host context snapshot.
 */
export interface UiContextValueMap {
  /** Active session identifier, if the framework shell has one. */
  session: string;
}

/** UI context dimension identifier, extensible via {@link UiContextValueMap}. */
export type UiContextDimension = keyof UiContextValueMap & string;

/** Snapshot of host UI context passed to contributed UI. */
export interface UiContextSnapshot {
  /** Active navigation level for the renderer surface. */
  readonly level: UiRuntimeNavigationLevel;
  /** Active context values keyed by registered context dimension. */
  readonly values: Partial<{
    readonly [K in UiContextDimension]: UiContextValueMap[K] | null;
  }>;
}

/**
 * Extensible registry of all known AI adapter capabilities.
 *
 * This interface can be extended by external packages (extensions) via declaration merging:
 * @example
 * ```typescript
 * // In a plugin package
 * declare module '@makaio/ai-adapters-core' {
 *   interface AIAdapterCapabilityRegistry {
 *     customAuth: {
 *       oauth: boolean;
 *       saml: boolean;
 *     };
 *   }
 * }
 *
 * // Now these work automatically:
 * caps.hasAll(['customAuth:oauth'])  // ✅ Type-safe
 * caps.customAuthOauth               // ✅ Auto-generated property
 * ```
 */
export interface AIAdapterCapabilityRegistry {
  systemPrompt: {
    override: boolean;
    append: boolean;
  };
  session: {
    resume: boolean;
    fork: boolean;
  };
  chat: {
    inTurnMessages: boolean;
  };
  modelSwitchInSession: boolean;
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  /**
   * Adapter supports native structured output (JSON schema enforcement
   * at the model level via response_format or equivalent).
   *
   * Sub-capability:
   * - `structuredOutput:strict` — adapter enforces strict schema validation
   *   (no additional properties, all fields required). Corresponds to
   *   `response_format: { type: 'json_schema', json_schema: { strict: true } }`
   *   in the OpenAI API.
   */
  structuredOutput: {
    strict: boolean;
  };
}

/**
 * Recursively builds capability path strings from registry.
 * Example: `'systemPrompt'` | `'systemPrompt:override'` | `'systemPrompt:append'`
 * @internal
 */
type CapabilityPath<T> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends boolean
          ? K
          : T[K] extends object
            ? `${K}:${CapabilityPath<T[K]>}` | K
            : K
        : never;
    }[keyof T]
  : never;

/** Union of all valid capability strings from the registry. */
export type ValidCapability = CapabilityPath<AIAdapterCapabilityRegistry>;

/**
 * Converts capability path to camelCase property name.
 * Example: `'session:fork'` → `'sessionFork'`
 * @internal
 */
type PathToPropertyName<S extends string> = S extends `${infer First}:${infer Rest}`
  ? `${First}${PathToPropertyName<Capitalize<Rest>>}`
  : S;

/** Flattens registry into camelCase boolean properties. @internal */
export type GeneratedCapabilityProperties = {
  [P in ValidCapability as PathToPropertyName<P>]?: boolean;
};

/**
 * Runtime-queryable capabilities object returned by AI adapters.
 *
 * Auto-generates boolean properties from {@link AIAdapterCapabilityRegistry}:
 * - `'systemPrompt'` → `caps.systemPrompt`
 * - `'systemPrompt:override'` → `caps.systemPromptOverride`
 * - `'session:fork'` → `caps.sessionFork`
 * @remarks
 * Capabilities are **optional and declarative**:
 * - Adapters declare only what their underlying service supports
 * - Platform checks capabilities before using optional features
 * - No "not implemented" exceptions
 * - Plugin-extendable via declaration merging
 * @example
 * ```typescript
 * const caps = adapter.getCapabilities();
 *
 * // Single checks (most common)
 * if (caps.vision) { ... }
 * if (caps.tools && caps.vision) { ... }
 *
 * // Batch checks (explicit AND/OR)
 * if (caps.hasAll(['vision', 'tools'])) { ... }
 * if (caps.hasAny(['session:resume', 'session:fork'])) { ... }
 * ```
 * @see {@link AIAdapterCapabilityRegistry} - Schema and plugin extensibility
 * @see {@link parseAIAdapterCapabilities} - Create instances from strings
 */
export type AIAdapterCapabilities = GeneratedCapabilityProperties & {
  /** Check if ALL specified capabilities are present (AND logic) */
  hasAll(capabilities: ValidCapability[]): boolean;

  /** Check if ANY of the specified capabilities are present (OR logic) */
  hasAny(capabilities: ValidCapability[]): boolean;
};

export type AIAdapterCapability = keyof GeneratedCapabilityProperties;

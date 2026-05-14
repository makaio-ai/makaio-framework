/** A single field in a subject's payload, request, or response schema. */
export interface SubjectField {
  /** Property name. */
  name: string;
  /** TypeScript type string, e.g. `'string'`, `'"completed" | "error"'`. */
  type: string;
  /** Whether the field is required (not optional). */
  required: boolean;
}

/** How a namespace was registered on the bus. */
export type NamespaceKind = 'bus' | 'storage' | 'adapter' | 'client' | 'extension' | 'extension-storage';

/** Documentation tier assigned to an analyzed namespace. */
export type NamespaceTier = 'framework' | 'host' | 'host-web' | 'extension';

/** Documentation bucket assigned to a namespace callsite. */
export type CallsiteTier = 'framework' | 'host';

/** Analyzed bus namespace extracted from source. */
export interface NamespaceEntry {
  /** Bus prefix string, e.g. 'agent', 'session', 'persona.runtime'. */
  prefix: string;

  /** Exported constant name, e.g. 'AgentNamespace'. */
  namespaceConstant: string;

  /** Exported subjects constant, e.g. 'AgentSubjects'. */
  subjectsConstant: string | null;

  /** Schema record variable name, e.g. 'AgentSchemas'. */
  schemaRecordName: string;

  /**
   * How this namespace was registered.
   * - `'bus'` — direct `MakaioBus.registerNamespace()` or `registerNamespace()`
   * - `'storage'` — `createStorageNamespace()`
   * - `'adapter'` — `createAdapterNamespace()`
   * - `'client'` — `createClientNamespace()`
   * - `'extension'` — `createExtensionNamespace()`
   * - `'extension-storage'` — `createExtensionStorageNamespace()`
   */
  kind: NamespaceKind;

  /** Documentation tier for grouping generated namespace docs. */
  tier: NamespaceTier;

  /** Where the namespace is defined. */
  definedIn: {
    file: string;
    package: string | null;
  };

  /** Individual subjects in this namespace. */
  subjects: SubjectEntry[];

  /** Files that reference the Subjects constant. */
  callsites: {
    framework: string[];
    host: string[];
  };
}

export interface SubjectEntry {
  /** Schema record key, e.g. 'tool.use', 'sendMessage'. */
  key: string;

  /** Full wire subject, e.g. 'agent.tool.use'. */
  wire: string;

  /** `'event'` for a bare Zod schema, or `'rpc'` for a schema with `request` and `response` properties. */
  type: 'event' | 'rpc';

  /** Source file where the schema for this subject is declared. Omitted when same as the namespace file. */
  schemaFile?: string;

  /** TSDoc/JSDoc description extracted from the schema symbol, if present. */
  description?: string;

  /** Fields of the event payload schema. Empty for an empty object schema; omitted when extraction does not apply. */
  payload?: SubjectField[];

  /** Fields of the RPC request schema. Empty for an empty object schema; omitted when extraction does not apply. */
  request?: SubjectField[];

  /** Fields of the RPC response schema. Empty for an empty object schema; omitted when extraction does not apply. */
  response?: SubjectField[];
}

export interface AnalysisResult {
  /** Timestamp of analysis. */
  analyzedAt: string;

  /** Source commit hash. */
  sourceCommit: string;

  /** All discovered namespaces. */
  namespaces: NamespaceEntry[];
}

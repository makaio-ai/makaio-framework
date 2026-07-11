import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import type {
  AdapterRuntimeOptions,
  AgentRole,
  AgentSelectionBase,
  AIReasoningLevel,
  ProviderContext,
  ResolvedAgentConfig,
  SessionContext,
  StartAgentRequest,
  StartAgentResponse,
} from '@makaio/contracts';

/** Runtime options plus model, providerContext, and reasoningEffort. */
export type ExtractableRuntimeOptions = Partial<
  AdapterRuntimeOptions & {
    adapterConfig: AgentSelectionBase['adapterConfig'];
    env: AgentSelectionBase['env'];
    mcpSessionContext: AgentSelectionBase['mcpSessionContext'];
    model: string;
    providerContext: ProviderContext;
    reasoningEffort: AIReasoningLevel;
  }
>;

/** Result of merging explicit and resolved runtime options. */
export type MergedRuntimeOptions = {
  runtimeOptions: ExtractableRuntimeOptions;
  mergedModel: string | undefined;
  mergedCwd: string | undefined;
};

/**
 * Extracts runtime options from agent selection base fields.
 * @param selection - Agent selection containing optional runtime override fields
 * @returns Filtered runtime options object
 */
export function extractRuntimeOptions(selection: AgentSelectionBase): ExtractableRuntimeOptions {
  return {
    ...(selection.model !== undefined && { model: selection.model }),
    ...(selection.reasoningEffort !== undefined && { reasoningEffort: selection.reasoningEffort }),
    ...(selection.cwd !== undefined && { cwd: selection.cwd }),
    ...(selection.allowedTools !== undefined && { allowedTools: selection.allowedTools }),
    ...(selection.disallowedTools !== undefined && { disallowedTools: selection.disallowedTools }),
    ...(selection.allowedDirectories !== undefined && { allowedDirectories: selection.allowedDirectories }),
    ...(selection.env !== undefined && { env: selection.env }),
    ...(selection.mcpSessionContext !== undefined && { mcpSessionContext: selection.mcpSessionContext }),
    ...(selection.adapterConfig !== undefined && { adapterConfig: selection.adapterConfig }),
    ...(selection.systemPrompt !== undefined && { systemPrompt: selection.systemPrompt }),
  };
}

/**
 * Merges explicit runtime options with resolved provider execution context and agent-selection values.
 * @param explicit - Runtime options extracted directly from the agent selection
 * @param resolved - Resolved agent config from host-tier resolution, or null for adapter kind
 * @param providerContext - Resolved provider execution context
 * @returns Merged runtime options plus merged model and cwd for identity persistence
 */
export function mergeRuntimeOptions(
  explicit: ExtractableRuntimeOptions,
  resolved: ResolvedAgentConfig | null,
  providerContext: ProviderContext | undefined,
): MergedRuntimeOptions {
  const mergedModel = explicit.model ?? resolved?.model;
  const mergedCwd = explicit.cwd;
  const runtimeOptions: ExtractableRuntimeOptions = omitUndefined({
    model: mergedModel,
    reasoningEffort: explicit.reasoningEffort ?? resolved?.reasoningEffort,
    cwd: mergedCwd,
    allowedTools: explicit.allowedTools ?? resolved?.allowedTools,
    disallowedTools: explicit.disallowedTools ?? resolved?.disallowedTools,
    allowedDirectories: explicit.allowedDirectories ?? resolved?.allowedDirectories,
    env: explicit.env,
    mcpSessionContext: explicit.mcpSessionContext,
    adapterConfig: explicit.adapterConfig,
    systemPrompt: explicit.systemPrompt ?? resolved?.systemPrompt,
    providerContext,
  });
  return { runtimeOptions, mergedModel, mergedCwd };
}

/** Effective cwd result after session-fallback resolution. */
export interface EffectiveAttachCwd {
  /** Resolved cwd: explicit override or stored session cwd. */
  readonly effectiveCwd: string | undefined;
  /** Runtime options with the effective cwd populated. */
  readonly effectiveRuntimeOptions: ExtractableRuntimeOptions;
}

/**
 * Resolve the effective attach working directory and produce runtime options
 * that always carry the resolved cwd.
 *
 * An attach without an explicit cwd means "attach where the session lives",
 * not "attach in the adapter's platform default". The returned
 * `effectiveRuntimeOptions` carries the resolved cwd so the downstream
 * startAgent request never falls back to the adapter default.
 * @param mergedCwd - Explicit cwd from the agent selection, or undefined
 * @param sessionCwd - Stored working directory on the session record
 * @param runtimeOptions - Merged runtime options from the agent selection
 * @returns Effective cwd and runtime options with the cwd populated
 */
export function resolveEffectiveAttachCwd(
  mergedCwd: string | undefined,
  sessionCwd: string | undefined,
  runtimeOptions: ExtractableRuntimeOptions,
): EffectiveAttachCwd {
  const effectiveCwd = mergedCwd ?? sessionCwd;
  const effectiveRuntimeOptions: ExtractableRuntimeOptions =
    effectiveCwd !== undefined && runtimeOptions.cwd === undefined
      ? { ...runtimeOptions, cwd: effectiveCwd }
      : runtimeOptions;
  return { effectiveCwd, effectiveRuntimeOptions };
}

/**
 * Removes keys whose value is `undefined` from an object literal.
 * @param obj - Object potentially containing `undefined` values
 * @returns A new object with `undefined`-valued keys omitted
 */
function omitUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Builds the startAgent request payload.
 *
 * When `resumeAdapterSessionId` is provided the request uses `mode: 'resume'`
 * so the adapter can attempt native session continuation rather than starting
 * a fresh context. If the adapter cannot honour the resume it falls back to
 * its default behaviour internally.
 *
 * For branching conversations, use session.fork to create a new session with
 * copied history, then attach agents to the new session.
 *
 * Managed attach always starts the agent idle. The session layer creates the
 * canonical turn and message identities before delivering any initial prompt
 * through `agent.sendMessage`.
 *
 * When `sessionContext` is provided (non-native resume paths), the locality
 * verdict is forwarded so adapters can act on it (e.g. inject history).
 * @param adapterId - Target adapter ID
 * @param sessionId - Target session ID
 * @param role - Agent role
 * @param runtimeOptions - Runtime configuration options (may include model, providerContext, reasoningEffort)
 * @param resumeAdapterSessionId - Adapter session ID to resume (enables resume mode)
 * @param harnessId - Resolved harness ID for tool policy lookup
 * @param sessionContext - Session context carrying locality verdict for non-native paths
 * @returns StartAgentRequest payload
 */
export function buildStartAgentRequest(
  adapterId: string,
  sessionId: string,
  role: AgentRole,
  runtimeOptions: ExtractableRuntimeOptions,
  resumeAdapterSessionId?: string,
  harnessId?: string,
  sessionContext?: SessionContext,
): StartAgentRequest {
  if (resumeAdapterSessionId) {
    return {
      mode: 'resume',
      adapterId,
      sessionId,
      adapterSessionId: resumeAdapterSessionId,
      role,
      ...runtimeOptions,
      ...(harnessId !== undefined && { harnessId }),
    };
  }
  return {
    adapterId,
    sessionId,
    role,
    ...runtimeOptions,
    ...(harnessId !== undefined && { harnessId }),
    ...(sessionContext !== undefined && { sessionContext }),
  };
}

/** Input bundle for launching an agent after all attach parameters have been resolved. */
export interface LaunchAttachAgentInput {
  readonly adapterId: string;
  readonly sessionId: string;
  readonly role: AgentRole;
  readonly effectiveRuntimeOptions: ExtractableRuntimeOptions;
  readonly resumeAdapterSessionId: string | undefined;
  readonly harnessId: string | undefined;
  readonly attachSessionContext: SessionContext | undefined;
}

/**
 * Build and dispatch the startAgent request, then surface any startup failure
 * as a thrown error.
 *
 * Groups the tightly-coupled startup operations — request construction and
 * adapter dispatch — into a single named step so
 * `attachAgent` reads as a clear orchestration of resolved-inputs → launch →
 * persist-identity → turn-setup.
 *
 * Startup failures are surfaced directly to the caller (UI/SDK) rather than
 * entering a degrade-and-retry path — that belongs to the coordinator layer.
 * @param bus - Bus instance for adapter dispatch
 * @param input - All resolved attach parameters required to construct and send the request
 * @returns The successful idle startAgent response containing agentId and adapterId
 */
export async function launchAttachAgent(
  bus: IMakaioBus,
  input: LaunchAttachAgentInput,
): Promise<Extract<StartAgentResponse, { success: true }>> {
  const {
    adapterId,
    sessionId,
    role,
    effectiveRuntimeOptions,
    resumeAdapterSessionId,
    harnessId,
    attachSessionContext,
  } = input;

  const startAgentRequest = buildStartAgentRequest(
    adapterId,
    sessionId,
    role,
    effectiveRuntimeOptions,
    resumeAdapterSessionId,
    harnessId,
    attachSessionContext,
  );
  const startResult = await bus.request(AdapterSubjects.startAgent, startAgentRequest);
  if (!startResult.success) {
    throw new Error(`[attach-handler] Failed to start agent: ${startResult.message}`);
  }
  return startResult;
}

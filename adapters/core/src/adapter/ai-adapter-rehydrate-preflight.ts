/**
 * What a cold rehydrate resolves before it may touch the provider.
 *
 * Separated from the rehydration manager because it is one cohesive step with
 * one rule: nothing in here reaches the provider, so nothing in here may fail
 * in a way a caller has to treat as uncertain.
 */
import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderKeyPublication } from './adapter-provider-key-publication.js';
import type { ExtractSubjectResponse } from '@makaio/core';
import type { AdapterSubjects, MakaioSessionAgent, McpSessionContext } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { resolveRuntimeProviderContext } from '@makaio/services-core/provider-context';
import { restoreAgentUsageFromTurns } from './restore-agent-usage.js';
import type { AgentCreationOptions } from './types.js';

/** The rehydrate response, as its handler answers it. */
type RehydrateAgentResponsePayload = ExtractSubjectResponse<typeof AdapterSubjects.rehydrateAgent>;

/** The modeled-refusal arm of the rehydrate response. */
export type RehydrateAgentRefusal = Extract<RehydrateAgentResponsePayload, { success: false }>;

/** Runtime overrides and ownership mode carried through both rehydrate paths. */
export interface RehydrateRuntime {
  /** Provider session to natively resume, evaluated by the caller. */
  rpcResumeId?: string | undefined;
  /** Working directory override for the replacement connector. */
  cwd?: string | undefined;
  /** Model override for the replacement connector. */
  model?: string | undefined;
  /** When set, the caller owns the agent row's status transitions. */
  callerOwnsAgentRow?: true | undefined;
  /** Adapter-minted token for the exact caller-owned generation. */
  settlementAckToken?: string | undefined;
  /**
   * The rehydrate's provider-key publication gate.
   *
   * Released only after the caller returns the acknowledgement token, so a
   * caller-owned generation publishes nothing before durable settlement.
   * Carried rather than re-derived so every route inside the rehydrate asks the
   * one gate — see {@link ProviderKeyPublication}.
   */
  publication: ProviderKeyPublication;
}

/** What the preflight needs from the adapter that owns it. */
export interface ColdRehydratePreflightDeps {
  /** Global bus every read is issued on. */
  readonly globalBus: IMakaioBus;
  /**
   * Re-resolve MCP session context from persisted keys.
   * @param sessionId - Session the agent belongs to.
   * @param profileId - Profile persisted with the agent, when there was one.
   */
  resolveMcpSessionContext: (
    sessionId: string,
    profileId: string | undefined,
  ) => Promise<McpSessionContext | undefined>;
}

/** Everything a cold rehydrate resolved before it may touch the provider. */
interface ColdRehydratePreflight {
  /** The stored agent this rehydrate rebuilds. */
  readonly persisted: MakaioSessionAgent;
  /** Creation options the replacement connector is built from. */
  readonly agentCreationRequest: AgentCreationOptions;
  /** Cumulative usage restored from persisted turn history. */
  readonly restoredUsage: Awaited<ReturnType<typeof restoreAgentUsageFromTurns>>;
}

/**
 * Build a modeled refusal — a rehydrate that never reached the provider.
 *
 * Returned instead of thrown so a caller holding a provider-session reservation
 * can release it cleanly; a throw is `dispatch-uncertain` by construction and
 * forces that caller to retire the key as possibly-live debris instead.
 * @param message - Human-readable reason for the refusal
 * @returns The `not-dispatched` refusal response
 */
export function notDispatched(message: string): RehydrateAgentRefusal {
  return { success: false, message, dispatch: 'not-dispatched' };
}

/**
 * Read and resolve everything a cold rehydrate needs before it may touch the
 * provider.
 *
 * **Every failure in here is a modeled refusal, not a throw.** None of these
 * steps can reach the provider, so a failure leaves no connector and nothing
 * to be uncertain about. Thrown, it would be `dispatch-uncertain` by
 * construction (§7.3) and a reserving caller would retire the provider
 * session's key over an unavailable credential store — the next attempt then
 * finds its own key `occupied` by a generation that never spoke to anything.
 * The boundary lives with the steps, as on the start path.
 * @param deps - Bus and the MCP resolver this adapter owns.
 * @param agentId - Agent identifier being rehydrated.
 * @param runtime - Runtime overrides from the rehydrate RPC payload.
 * @returns The inputs a dispatch needs, or the refusal that stops it.
 */
export async function prepareColdRehydrate(
  deps: ColdRehydratePreflightDeps,
  agentId: string,
  runtime: RehydrateRuntime,
): Promise<ColdRehydratePreflight | RehydrateAgentRefusal> {
  const { rpcResumeId, cwd, model } = runtime;
  try {
    const result = await deps.globalBus.requestOptional(AgentStorageSubjects.get, { agentId });
    if (!result.handled || !result.data.agent) {
      return notDispatched(`Agent ${agentId} not found in storage`);
    }
    const persisted = result.data.agent;
    if (persisted.status === 'disposed') {
      return notDispatched(`Agent ${agentId} is disposed and cannot be rehydrated`);
    }
    // Re-resolve MCP session context from persisted keys so the rehydrated agent
    // regains tool ledger and native passthrough. Best-effort: resolves to
    // undefined if the MCP service is unavailable on this process start.
    const mcpSessionContext = await deps.resolveMcpSessionContext(persisted.sessionId, persisted.profileId);
    const providerContext =
      persisted.providerConfigId !== undefined
        ? await resolveRuntimeProviderContext(deps.globalBus, {
            adapterName: persisted.adapterName,
            providerConfigId: persisted.providerConfigId,
          })
        : undefined;
    // A resumed generation's identity is the session it resumes — a divergent
    // identity marker would seed the connector with the old ID, leaving the agent
    // reporting an identity it is not actually writing to. A fresh generation
    // mints its own provider identity instead: pinning a used session ID on a
    // fresh start collides with the provider's durable session store (claude
    // CLI: "Session ID already in use").
    const agentCreationRequest: AgentCreationOptions = {
      model: model ?? persisted.model,
      cwd: cwd ?? persisted.cwd,
      allowedDirectories: persisted.allowedDirectories,
      ...(rpcResumeId !== undefined && {
        adapterSessionId: rpcResumeId,
        resumeAdapterSessionId: rpcResumeId,
      }),
      ...(providerContext !== undefined && { providerContext }),
      ...(mcpSessionContext !== undefined && { mcpSessionContext }),
    };
    // Restore cumulative usage baseline from persisted turn history.
    // Without this, the adapter's in-memory totals would restart from zero
    // after every process restart, making session-level usage unreliable.
    const restoredUsage = await restoreAgentUsageFromTurns(deps.globalBus, persisted.sessionId, agentId);
    return { persisted, agentCreationRequest, restoredUsage };
  } catch (error) {
    return notDispatched(
      `Agent ${agentId} could not be prepared for rehydration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

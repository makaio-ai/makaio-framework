/**
 * Turning a send's public agent selection into the direct adapter selection the
 * fresh-start path dispatches.
 *
 * Free functions rather than orchestrator methods: the selection knowledge is
 * request-shaped, not lifecycle-shaped, and a degrade that has to mint a
 * replacement lead needs it without owning an orchestrator.
 * @packageDocumentation
 */
import type { IMakaioBus } from '@makaio/bus-core';
import {
  CanonicalModelSubjects,
  isCanonicalModelParseError,
  parseCanonicalModel,
  type AdapterSelection,
  type AgentSelectionBase,
  type CanonicalModelSelection,
  type MessageInput,
  type SessionContext,
} from '@makaio/contracts';
import { extractTextContent } from './session-orchestrator-helpers-core.js';
import { normalizeSelectionString, resolveAdapterNameById } from './selection-utils.js';

/**
 * Resolve the adapter name for a direct adapter selection.
 *
 * Adapter startup and persisted identity require a stable adapter name.
 * When the caller provides `adapterId`, the framework validates any explicit
 * name against the adapter-subsystem reverse lookup and otherwise backfills the
 * canonical adapter name from that subsystem-owned mapping.
 * @param bus - Bus the adapter-subsystem lookup is issued on
 * @param selection - Direct adapter selection
 * @param sessionId - Session ID used in error messages
 * @returns Resolved adapter name
 */
export async function resolveSelectionAdapterName(
  bus: IMakaioBus,
  selection: AdapterSelection,
  sessionId: string,
): Promise<string> {
  const explicitAdapterName = normalizeSelectionString(selection.adapterName);
  const adapterId = normalizeSelectionString(selection.adapterId);

  if (!explicitAdapterName && !adapterId) {
    throw new Error(
      `[SessionOrchestrator.sendMessage] adapterName or adapterId required when session has no agents (sessionId=${sessionId})`,
    );
  }

  if (adapterId) {
    return resolveAdapterNameById(
      bus,
      adapterId,
      explicitAdapterName,
      `[SessionOrchestrator.sendMessage] (sessionId=${sessionId}) `,
    );
  }

  // Narrowed rather than asserted: the guard above already rejected "neither",
  // so this branch is reachable only with a name — but a cast says that to the
  // reader and to nobody else, and it would keep compiling if that guard ever
  // moved.
  if (explicitAdapterName === undefined) {
    throw new Error(`[SessionOrchestrator.sendMessage] adapterName could not be resolved (sessionId=${sessionId})`);
  }
  return explicitAdapterName;
}

/**
 * Resolve the public agent selection into the direct adapter shape required
 * by the framework orchestrator's startup path.
 * @param bus - Bus any resolver round trip is issued on.
 * @param selection - Public session agent selection from the request.
 * @param sessionId - Session ID used for context and diagnostics.
 * @param message - User message used as canonical-model prompt context.
 * @param sessionContext - Optional session context passed through the request.
 * @returns Direct adapter selection for `adapter.startAgent`.
 */
export async function resolveInitialAdapterSelection(
  bus: IMakaioBus,
  selection: AgentSelectionBase | undefined,
  sessionId: string,
  message: MessageInput,
  sessionContext: SessionContext | undefined,
): Promise<AdapterSelection> {
  if (!selection) {
    throw new Error(
      `[SessionOrchestrator.sendMessage] agent selection required when session has no agents (sessionId=${sessionId})`,
    );
  }

  if (selection.kind === 'adapter') {
    return selection as AdapterSelection;
  }

  if (selection.kind === 'canonical-model') {
    return await resolveCanonicalModelSelection(
      bus,
      selection as CanonicalModelSelection,
      sessionId,
      message,
      sessionContext,
    );
  }

  throw new Error(
    `[SessionOrchestrator.sendMessage] agent with kind: 'adapter' or 'canonical-model' required when session has no agents (sessionId=${sessionId})`,
  );
}

/**
 * Resolve a canonical-model selection to a direct adapter selection.
 * @param bus - Bus the canonical-model resolution is issued on.
 * @param selection - Canonical model selection from the session request.
 * @param sessionId - Session ID used for context and diagnostics.
 * @param message - User message used as canonical-model prompt context.
 * @param sessionContext - Optional session context passed through the request.
 * @returns Direct adapter selection with resolved adapter, provider config, and model.
 */
async function resolveCanonicalModelSelection(
  bus: IMakaioBus,
  selection: CanonicalModelSelection,
  sessionId: string,
  message: MessageInput,
  sessionContext: SessionContext | undefined,
): Promise<AdapterSelection> {
  const parsed = parseCanonicalModel(selection.model);
  if (isCanonicalModelParseError(parsed)) {
    throw new Error(
      `[SessionOrchestrator.sendMessage] Invalid canonical model "${selection.model}" (sessionId=${sessionId}): ${parsed.message}`,
    );
  }

  if (parsed.kind === 'virtual') {
    throw new Error(
      `[SessionOrchestrator.sendMessage] Virtual canonical models require a host resolver (sessionId=${sessionId})`,
    );
  }

  const resolved = await bus.request(CanonicalModelSubjects.resolve, {
    parsed,
    context: {
      sessionId,
      promptText: extractTextContent(message),
      ...(sessionContext !== undefined ? { sessionContext } : {}),
    },
  });

  return {
    ...selection,
    ...resolved,
    kind: 'adapter',
    providerConfigId: selection.providerConfigId ?? resolved.providerConfigId,
  };
}

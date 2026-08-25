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
  type ResolvedProviderContext,
  type SessionContext,
} from '@makaio/contracts';
import { extractTextContent } from './session-orchestrator-helpers-core.js';
import type { AdapterRegistry } from './adapter-registry.js';
import { SessionStartError } from './handlers/session-start-error.js';
import { resolveOwnedAdapterInstance, type MachineScopedAdapterInstance } from './utils/resolution.js';
import { resolveRuntimeProviderContext } from '../provider-context/index.js';
import {
  describeHalfNamedInstanceRefusal,
  normalizeSelectionString,
  resolveAdapterNameById,
  type NamedSelectionInstance,
} from './selection-utils.js';

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

/** What resolving a fresh start's instance needs beyond the selection itself. */
export interface SelectionInstanceContext {
  /** Adapter type name already resolved for the selection. */
  readonly adapterName: string;
  /** Session identity, for the refusal message. */
  readonly sessionId: string;
  /** This runtime's machine identity, used when it resolves the instance itself. */
  readonly machineId: string;
  /** Registry that resolves an adapter name to a live instance for a named machine. */
  readonly registry: Pick<AdapterRegistry, 'resolveAvailable'>;
}

/**
 * Resolve the instance a fresh lead start dispatches to, together with the
 * machine every one of its ownership acts names.
 *
 * **A fresh start always has a machine, and that is what closes the last hole
 * in the degrade matrix.** Its *reservation* is keyless and therefore cannot
 * see the machine's absence — but its *settlement* is keyed, on the provider
 * session the connector confirms, so an unnamed machine surfaced there as an
 * outcome no caller on this path had a policy for. Naming the machine here
 * removes the case by construction rather than by a new branch.
 *
 * Two shapes, and the asymmetry is deliberate:
 *
 * - **No instance named:** resolve one for this runtime's own machine, and
 *   hand that same machine to the start. The instance ID is derived from
 *   `(machineId, adapterName)`, so passing one identity to the resolution and
 *   the other to the start is the mixed key; passing the same value to both is
 *   what makes them provably agree.
 * - **An instance named:** its machine comes from the caller, because the
 *   derivation is one-way and this runtime must not invent one.
 *
 * **A selection that named one half without the other is refused before either
 * branch runs**, by the rule {@link describeHalfNamedInstanceRefusal} states for
 * every path that reads the pair. Refusing first is what makes the two branches
 * above total: each one holds a pair it can honour, so neither has to decide what
 * to do with half of one.
 * @param bus - Bus the resolution is issued on.
 * @param selection - Direct adapter selection this start runs from.
 * @param context - Adapter name, session identity, this runtime's machine and its instance registry.
 * @returns The instance and the machine, as one key.
 * @throws A {@link SessionStartError} when an identity is incomplete or its
 *   complete explicit triple has no matching live announcement.
 */
export async function resolveSelectionOwnedInstance(
  bus: IMakaioBus,
  selection: AdapterSelection,
  context: SelectionInstanceContext,
): Promise<MachineScopedAdapterInstance> {
  const { adapterName, sessionId, machineId } = context;
  const named: NamedSelectionInstance = {
    adapterId: normalizeSelectionString(selection.adapterId),
    machineId: normalizeSelectionString(selection.machineId),
  };
  const refusal = describeHalfNamedInstanceRefusal(named, {
    sessionId,
    errorPrefix: '[SessionOrchestrator.sendMessage] ',
  });
  if (refusal !== undefined) throw new SessionStartError('start-failed', refusal);
  if (named.adapterId === undefined) {
    const owned = await resolveOwnedAdapterInstance(bus, {
      adapterName,
      machineId,
    });
    if (owned === undefined || owned.machineId === undefined || owned.ownerInstanceId === undefined) {
      throw new SessionStartError(
        'start-failed',
        `[SessionOrchestrator.sendMessage] adapter runtime did not prove a live owner for ${adapterName} (sessionId=${sessionId})`,
      );
    }
    return { adapterId: owned.adapterId, machineId: owned.machineId, ownerInstanceId: owned.ownerInstanceId };
  }
  const owned = await resolveOwnedAdapterInstance(bus, {
    adapterName,
    adapterId: named.adapterId,
    ...(named.machineId !== undefined && { machineId: named.machineId }),
  });
  if (owned?.machineId === undefined) {
    // A complete selection is still refused when the live announcement does not
    // prove its exact adapter ID/name/machine triple. The optional return also
    // serves deriving callers, which is why this explicit path narrows it here.
    throw new SessionStartError(
      'start-failed',
      `[SessionOrchestrator.sendMessage] agent instance resolution for ${named.adapterId} produced no machine (sessionId=${sessionId})`,
    );
  }
  if (owned.ownerInstanceId === undefined) {
    throw new SessionStartError(
      'start-failed',
      `[SessionOrchestrator.sendMessage] agent instance resolution for ${named.adapterId} produced no owner (sessionId=${sessionId})`,
    );
  }
  return { adapterId: owned.adapterId, machineId: owned.machineId, ownerInstanceId: owned.ownerInstanceId };
}

/** The target a fresh lead start dispatches to, resolved from its selection. */
export interface FreshStartTarget {
  /** Canonical adapter type name the start is dispatched under. */
  readonly adapterName: string;
  /** Instance the dispatch addresses, and the machine its ownership acts name. */
  readonly instance: MachineScopedAdapterInstance;
  /** Resolved provider credentials, when the selection named a provider config. */
  readonly providerContext: ResolvedProviderContext | undefined;
  /** Provider config the agent row is stamped with, from the selection or the resolution. */
  readonly providerConfigId: string | undefined;
}

/**
 * Resolve everything about *where* a fresh lead start runs, in one place.
 *
 * The name, the instance, the machine and the credentials are all read off one
 * selection, and every one of them has to describe the same target: the row is
 * stamped with the name, the dispatch addresses the instance, the ownership acts
 * name the machine, and the connector authenticates with the credentials. Reading
 * them at four call sites is how three of them can end up describing a target the
 * fourth does not.
 * @param bus - Bus every resolution round trip is issued on.
 * @param selection - Direct adapter selection this start runs from.
 * @param context - Session identity, this runtime's machine and its instance registry.
 * @returns The resolved target of the start.
 */
export async function resolveFreshStartTarget(
  bus: IMakaioBus,
  selection: AdapterSelection,
  context: Omit<SelectionInstanceContext, 'adapterName'>,
): Promise<FreshStartTarget> {
  const adapterName = await resolveSelectionAdapterName(bus, selection, context.sessionId);
  // Both round trips need only the name, so they are issued together rather than
  // one behind the other: two sequential bus requests cost a start two latencies
  // to answer one question. They are still *awaited* in order, so a selection that
  // is wrong about both its instance and its provider config keeps failing with the
  // instance error rather than with whichever request lost the race.
  const providerContextResolution =
    selection.providerConfigId === undefined
      ? undefined
      : resolveRuntimeProviderContext(bus, { adapterName, providerConfigId: selection.providerConfigId });
  // The provider resolution has no consumer left once the instance fails, and an
  // unobserved rejection must not escape the start. Awaiting it below is unaffected.
  providerContextResolution?.catch(() => undefined);
  const instance = await resolveSelectionOwnedInstance(bus, selection, { ...context, adapterName });
  const providerContext = await providerContextResolution;
  return {
    adapterName,
    instance,
    providerContext,
    providerConfigId: selection.providerConfigId ?? providerContext?.providerConfigId,
  };
}

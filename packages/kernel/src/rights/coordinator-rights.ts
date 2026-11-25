import type { JsonValue } from '@makaio/contracts';
import type { BoundaryAccessCheck, IMakaioBus } from '@makaio/bus-core';
import { assertCallCarrier, busContextOf, mintCallContext } from '@makaio/bus-core/kernel-api';
import { CoreDenialPlace, HostOnlyRightsError, type DenialPlace } from '@makaio/contracts/access';
import { MAKAIO_RULES_PARTY_KIND, type CallContext } from '@makaio/core';
import {
  RightDenialReason,
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
  type RightAnswer,
  type RightQuestion,
  type RightsCapability,
} from '@makaio/contracts/rights';
import { createBoundaryAccessCheck, type BoundaryPhase } from './boundary-access.js';
import { registerRightsHandlers } from './rights-handlers.js';
import { CORE_RIGHTS_OWNER } from './rights-directory.js';
import { createRefusedRightsHub, createRightsHub, type RightsHub } from './rights-hub.js';

const ruleCarrier = { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND };

/** Authorization operations used by the host's built-in rule contributions. */
interface RuleRights {
  /** @returns The live directory names used to check a prospective rule. */
  listRights(): readonly string[];
  /** @param pattern - Proposed subscription.
   * @param check - Optional candidate catalog context.
   * @returns Whether the evaluator may subscribe.
   */
  canSubscribe(pattern: string, check: JsonValue | undefined): Promise<boolean>;
  /** @param subject - Proposed outgoing request.
   * @param check - Optional candidate catalog context.
   * @returns Whether the evaluator may send.
   */
  canSend(subject: string, check: JsonValue | undefined): Promise<boolean>;
  /**
   * Resolve a lookup's question and announce a meaningful denial. The host
   * owns this resolver across activations, so it checks the built-in owner's
   * current activation and the evaluation carrier on each call.
   */
  readonly resolveLookupRight: RightsCapability['resolve'];
  /**
   * Authorize a rule reaction's request through the same rights resolver.
   * @param call - The rule evaluation's call.
   * @param subject - Full subject of the outgoing request.
   * @param payload - Resolved request payload.
   * @returns The combined resolution.
   */
  resolveRuleSendRight(call: CallContext, subject: string, payload?: JsonValue): Promise<RightAnswer>;
}

/** Rights surfaces needed by the extension coordinator and its host. */
export type CoordinatorRights = Pick<RightsHub, 'capabilityFor' | 'beginActivation' | 'activate' | 'deactivate'> & {
  /** Shared resolver for the built-in rule contributions. */
  readonly ruleRights: RuleRights;
  /** Register this host's rights request handlers. */
  registerHandlers(): Array<() => void>;
  /** Admit external operations after startup. */
  openBoundary(): void;
  /** Close external admission for the lifetime of this host. */
  closeBoundary(): void;
  /** Whether all startup contributions are installed. */
  isBoundaryReady(): boolean;
  /** Check an operation at the transport boundary. */
  readonly checkBoundaryAccess: BoundaryAccessCheck;
  /** Rights operations for callers composing services inside this host. */
  readonly hostRights: {
    /**
     * Resolve a host-local right against the same active sources as the transport.
     * Stored rows represent work already admitted to the host. Their readers are
     * governed by the local activation lifecycle and resolve access independently
     * of the transport's readiness and shutdown gate. Host composition reaches
     * this resolver only through the extension coordinator.
     * @param question - The right, minted call, and context to check.
     * @returns The combined answer from the host resolver.
     */
    resolve(question: RightQuestion): Promise<RightAnswer>;
    /** Announce a host operation's denial through the common denial sink. */
    readonly deny: RightsHub['deny'];
  };
};

/**
 * Resolve one rule question and publish its denial when it was answered.
 * @param hub - Shared host rights hub.
 * @param at - Rule operation that asked.
 * @param question - Question for the current call.
 * @param subject - Subject for a send denial, when applicable.
 * @returns The combined rights answer.
 */
async function resolveRuleRight(
  hub: RightsHub,
  at: DenialPlace,
  question: RightQuestion,
  subject?: string,
): Promise<RightAnswer> {
  const answer = await hub.resolve(question);
  if (!answer.granted && answer.reason !== RightDenialReason.sourceUnavailable) {
    const { call, right } = question;
    hub.deny(at, { call, right, subject, reason: answer.reason, by: answer.by });
  }
  return answer;
}

/**
 * Supply the lifecycle, request handlers and transport policy of one coordinator.
 * @param bus - The coordinator's host bus.
 * @param mode - Whether this composition owns host rights.
 * @returns The coordinator's rights surfaces, sharing one resolver.
 */
export function createCoordinatorRights(bus: IMakaioBus, mode: 'host' | 'refused' | undefined): CoordinatorRights {
  const ownsRights = mode !== 'refused';
  const hub = ownsRights ? createRightsHub({ bus }) : createRefusedRightsHub();
  let phase: BoundaryPhase = 'starting';
  const validationCall = mintCallContext({ caller: ruleCarrier, principal: ruleCarrier });
  return {
    openBoundary: () => {
      if (phase === 'starting') phase = 'ready';
    },
    closeBoundary: () => {
      phase = 'closed';
    },
    isBoundaryReady: () => phase === 'ready',
    capabilityFor: hub.capabilityFor,
    ruleRights: {
      listRights: () => hub.list().map(({ right }) => right),
      canSubscribe: async (pattern, check) =>
        (
          await hub.resolve(
            {
              call: validationCall,
              right: SUBJECT_SUBSCRIBE_RIGHT,
              context: check === undefined ? { pattern } : { pattern, check },
            },
            { bypassCache: true },
          )
        ).granted,
      canSend: async (subject, check) =>
        (
          await hub.resolve(
            {
              call: validationCall,
              right: SUBJECT_SEND_RIGHT,
              context: check === undefined ? { subject } : { subject, check },
            },
            { bypassCache: true },
          )
        ).granted,
      async resolveLookupRight(call, { right, context }) {
        if (!ownsRights) throw new HostOnlyRightsError();
        assertCallCarrier(call, ruleCarrier, busContextOf(bus));
        if (!hub.isOwnerActive(CORE_RIGHTS_OWNER)) throw new Error('Built-in rule lookups are not active.');
        return resolveRuleRight(hub, CoreDenialPlace.lookup, { call, right, context });
      },
      resolveRuleSendRight: (call, subject, payload) =>
        resolveRuleRight(
          hub,
          CoreDenialPlace.send,
          { call, right: SUBJECT_SEND_RIGHT, context: payload === undefined ? { subject } : { subject, payload } },
          subject,
        ),
    },
    beginActivation: hub.beginActivation,
    activate: hub.activate,
    deactivate: hub.deactivate,
    registerHandlers: () => (ownsRights ? registerRightsHandlers(bus, hub) : []),
    checkBoundaryAccess: createBoundaryAccessCheck(bus, hub, () => phase),
    hostRights: { resolve: (question) => hub.resolve(question), deny: hub.deny },
  };
}

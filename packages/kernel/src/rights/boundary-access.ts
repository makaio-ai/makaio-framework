import {
  isRequestSchema,
  SUBSCRIPTION_DEFERRED,
  matchesSubscription,
  type BoundaryAccessCheck,
  type BoundaryAccessTarget,
  type IMakaioBus,
  type RegisteredSubjectSchema,
} from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import { CoreDenialPlace } from '@makaio/contracts/access';
import { SubjectNameSchema, SubjectPatternSchema } from '@makaio/contracts/journal';
import {
  SUBJECT_HANDLE_RIGHT,
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
  type RightName,
} from '@makaio/contracts/rights';
import { connectionOf } from './rights-handlers.js';
import type { RightsHub } from './rights-hub.js';

export type BoundaryPhase = 'starting' | 'ready' | 'closed';

const RIGHT_BY_OPERATION = {
  send: SUBJECT_SEND_RIGHT,
  subscribe: SUBJECT_SUBSCRIBE_RIGHT,
  deliver: SUBJECT_SUBSCRIBE_RIGHT,
  'register-handler': SUBJECT_HANDLE_RIGHT,
  handle: SUBJECT_HANDLE_RIGHT,
} satisfies Record<BoundaryAccessTarget['operation'], RightName>;

const isVisible = (entry: RegisteredSubjectSchema): boolean => !entry.local && !entry.channel;

/**
 * Check whether an operation exceeds the read-only contract of startup observation.
 * @param target - Concrete subject operation at the transport boundary.
 * @param entry - Registered metadata for the subject, when present.
 * @returns Whether the operation is forbidden by the startup observation contract.
 */
function isStartupObservationWrite(
  target: Extract<BoundaryAccessTarget, { namespace: string }>,
  entry: RegisteredSubjectSchema | undefined,
): boolean {
  return (
    entry?.startupObservable === true &&
    (target.operation === 'handle' ||
      (target.operation === 'send' && (target.messageType !== 'request' || !isRequestSchema(entry.schema))))
  );
}

/**
 * Apply the host's subject directory and rights resolver at the transport boundary.
 * Only startup-observable namespaces can pass authorization while the host starts.
 * @param bus - Host bus holding live subject metadata and namespace ownership.
 * @param hub - The same rights hub used by extension capabilities.
 * @param phase - Current inbound admission phase.
 * @returns The boundary check for the transport.
 */
export function createBoundaryAccessCheck(
  bus: IMakaioBus,
  hub: RightsHub,
  phase: () => BoundaryPhase,
): BoundaryAccessCheck {
  const { namespaceRegistry: registry } = busContextOf(bus);
  const hasActiveOwner = (entry: RegisteredSubjectSchema): boolean => {
    const owner = registry.ownerOf(entry.namespace);
    return owner?.kind === 'host' || (owner?.kind === 'extension' && hub.isOwnerActive(owner.extension));
  };
  const patternAvailability = (target: Extract<BoundaryAccessTarget, { pattern: string }>, starting: boolean) => {
    const { pattern, operation, defer } = target;
    if (!SubjectPatternSchema.safeParse(pattern).success) return 'invalid-pattern';
    const exact = registry.getRegisteredSubject(pattern);
    const matching = pattern.endsWith('*')
      ? registry.listRegisteredSubjects().filter(({ fullSubject }) => matchesSubscription(fullSubject, pattern))
      : exact
        ? [exact]
        : [];
    if (operation === 'register-handler' && matching.some((entry) => entry.startupObservable)) {
      return 'startup-observable-read-only';
    }
    const eligible = matching.filter(
      (entry) => isVisible(entry) && (operation !== 'register-handler' || isRequestSchema(entry.schema)),
    );
    const available = eligible.some(hasActiveOwner);
    if (!available && defer && (matching.length === 0 || eligible.length > 0)) return SUBSCRIPTION_DEFERRED;
    if (starting && !(matching.length > 0 && matching.every((entry) => entry.startupObservable))) {
      return defer === 'replay' ? SUBSCRIPTION_DEFERRED : 'host-not-ready';
    }
    return available ? undefined : 'subject-not-registered';
  };
  const subjectAvailability = (
    target: Extract<BoundaryAccessTarget, { namespace: string }>,
    subject: string | undefined,
    starting: boolean,
  ) => {
    const entry = subject === undefined ? undefined : registry.getRegisteredSubject(subject);
    if (starting && !entry?.startupObservable) return 'host-not-ready';
    if (isStartupObservationWrite(target, entry)) return 'startup-observable-read-only';
    if (
      !entry ||
      entry.namespace !== target.namespace ||
      !isVisible(entry) ||
      !hasActiveOwner(entry) ||
      (target.operation === 'handle' && !isRequestSchema(entry.schema))
    )
      return 'subject-not-registered';
  };
  const check: BoundaryAccessCheck = async (target, call, connection) => {
    const at = CoreDenialPlace[target.operation];
    const right = RIGHT_BY_OPERATION[target.operation];
    const subject = 'pattern' in target ? undefined : `${target.namespace}.${target.subject}`;
    const parsed = SubjectNameSchema.safeParse(subject);
    const denial = { call, right, ...(parsed.success ? { subject: parsed.data } : {}) };
    const currentPhase = phase();
    if (currentPhase === 'closed') return hub.deny(at, { ...denial, reason: 'host-not-ready' });
    const starting = currentPhase === 'starting';
    const availability =
      'pattern' in target ? patternAvailability(target, starting) : subjectAvailability(target, parsed.data, starting);
    if (availability === SUBSCRIPTION_DEFERRED) return availability;
    if (availability !== undefined) return hub.deny(at, { ...denial, reason: availability });
    const context = 'pattern' in target ? { pattern: target.pattern } : { subject };
    const answer = await hub.resolve(
      { call, right, context },
      {
        connection: connectionOf(connection),
        ...('namespace' in target && subject !== undefined && target.payload !== undefined
          ? { externalPayload: { subject, payload: target.payload } }
          : {}),
      },
    );
    if (phase() === 'closed') return hub.deny(at, { ...denial, reason: 'host-not-ready' });
    return answer.granted ? undefined : hub.deny(at, { ...denial, reason: answer.reason, by: answer.by });
  };
  check.reportRejectedReply = (call, reason) => {
    hub.deny(CoreDenialPlace.boundary, { call, reason });
  };
  return check;
}

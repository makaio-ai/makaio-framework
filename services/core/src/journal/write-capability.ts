import type { IMakaioBus } from '@makaio/bus-core';
import { assertCallCarrier, busCarrierOf, busContextOf } from '@makaio/bus-core/kernel-api';
import { AccessDeniedError, CoreDenialPlace } from '@makaio/contracts/access';
import type { HostDatabase } from '@makaio/contracts';
import {
  JournalResolveWriteRequestSchema,
  JournalSubjects,
  JournalWritesRequestSchema,
  type JournalResolveWriteRequest,
  type JournalWritesRequest,
  type WriteRequest,
  WriteRequestSchema,
  type WritesCapability,
} from '@makaio/contracts/journal';
import { type CallContext, getFullSubjectForSubjectDefinition } from '@makaio/core';
import { SUBJECT_SEND_RIGHT } from '@makaio/contracts/rights';
import type { CoordinatorRights } from '@makaio/kernel';
import { ExternalWriteJournal } from './external-write.js';
import { WriteContributionProcessor } from './write-contributions.js';

/** Host policy for authorizing journal calls and deriving their deadlines. */
export interface WriteJournalPolicy {
  /**
   * Check the business right for writing before accessing storage or requesting a credential.
   * @param call - Host-issued context of the original operation.
   * @param scope - Writer and key being accessed.
   * @returns Whether access is granted.
   */
  authorizeWrite(call: CallContext, scope: Pick<WriteRequest, 'writer' | 'key'>): Promise<boolean>;

  /**
   * Supply the writer deadline, including the host's positive grace period.
   * @param call - Host-issued context of the operation.
   * @returns Epoch milliseconds at which the writer must stop work.
   */
  deadline(call: CallContext): number;
}

/**
 * Create the journal and bind its local bus handlers.
 * @param host - Shared host database facade.
 * @param bus - Host bus serving the journal subjects.
 * @param rights - Rights resolver shared by all journal readers and the bus.
 * @param policy - Host policy for writes and deadlines.
 * @returns Contribution processor, per-extension capability and cleanup.
 */
export function createWriteJournal(
  host: HostDatabase,
  bus: IMakaioBus,
  rights: CoordinatorRights['hostRights'],
  policy: WriteJournalPolicy,
) {
  const contributions = new WriteContributionProcessor();
  const journal = new ExternalWriteJournal(host, contributions);

  const readSubject = getFullSubjectForSubjectDefinition(JournalSubjects.writes);
  const resolveSubject = getFullSubjectForSubjectDefinition(JournalSubjects['resolve-write']);

  /**
   * Apply the same subject right to direct and bus journal queries.
   * @param call - Host-issued context.
   * @param subject - Local journal subject.
   * @param payload - Validated request, with no transaction authority attached.
   */
  async function authorizeSubject(
    call: CallContext,
    subject: string,
    payload: JournalWritesRequest | JournalResolveWriteRequest,
  ): Promise<void> {
    const right = SUBJECT_SEND_RIGHT;
    const answer = await rights.resolve({ call, right, context: { subject, payload } });
    if (!answer.granted) {
      const at = subject === readSubject ? CoreDenialPlace.read : CoreDenialPlace.handler;
      throw rights.deny(at, { call, right, subject, reason: answer.reason, by: answer.by });
    }
  }

  const offRead = bus.on(JournalSubjects.writes, async ({ call, payload, setResult }) => {
    const request = JournalWritesRequestSchema.parse(payload);
    await authorizeSubject(call, readSubject, request);
    setResult(await journal.store.page(request));
  });
  const offResolve = bus.on(JournalSubjects['resolve-write'], async ({ call, payload, setResult }) => {
    const request = JournalResolveWriteRequestSchema.parse(payload);
    await authorizeSubject(call, resolveSubject, request);
    setResult(await journal.resolve(call, request));
  });

  return {
    contributions,
    /**
     * Bind authority to the extension and its carrier.
     * @param owner - Extension receiving the capability.
     * @param carrier - Extension's bus carrier.
     * @param isActive - Whether the extension may use the capability.
     * @returns The per-extension write and read operations.
     */
    bind(owner: string, carrier: IMakaioBus, isActive: () => boolean): WritesCapability {
      const party = busCarrierOf(carrier);
      const context = busContextOf(carrier);
      return {
        /**
         * @param call - Context of the requesting extension.
         * @param input - Write request.
         * @returns The durable write outcome.
         */
        async write(call, input) {
          assertCallCarrier(call, party, context);
          if (!isActive()) return { error: 'transient', reason: 'extension-not-active' };
          const parsed = WriteRequestSchema.safeParse(input);
          if (!parsed.success) return { error: 'invalid-request', reason: 'invalid-write-request' };
          const request = parsed.data;
          const { writer, key } = request;
          if (!(await policy.authorizeWrite(call, { writer, key }))) {
            throw rights.deny(CoreDenialPlace.handler, { call, reason: 'write-journal-access-denied' });
          }
          const deadline = policy.deadline(call);
          if (!Number.isSafeInteger(deadline) || deadline > 8_640_000_000_000_000) {
            throw new RangeError('Invalid write deadline.');
          }
          return journal.write(owner, call, request, deadline);
        },
        /**
         * @param call - Context of the requesting extension.
         * @param input - Write query and optional caller transaction.
         * @returns One page of matching writes.
         */
        async readWrites(call, { tx, ...input }) {
          assertCallCarrier(call, party, context);
          if (!isActive()) throw new AccessDeniedError({ at: CoreDenialPlace.read, reason: 'extension-not-active' });
          const request = JournalWritesRequestSchema.parse(input);
          await authorizeSubject(call, readSubject, request);
          return journal.store.page(request, tx);
        },
      };
    },
    /** Remove journal bus handlers. */
    destroy(): void {
      offResolve();
      offRead();
    },
  };
}

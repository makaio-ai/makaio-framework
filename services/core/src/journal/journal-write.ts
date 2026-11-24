import type { IMakaioBus } from '@makaio/bus-core';
import { assertCallCarrier, busCarrierOf, busContextOf } from '@makaio/bus-core/kernel-api';
import {
  JournalError,
  type AcceptEntryInput,
  type EdgeName,
  type EntryRecordOutcome,
  type HostDatabase,
  type HostTransaction,
  type InboundEdgeContribution,
  type JournalCapability,
  type JournalEdgeCapability,
  type SubjectName,
} from '@makaio/contracts';
import { inspectSubjectSchema, isRequestSchema, MAKAIO_WITNESSED_ACCOUNT_PARTY_KIND } from '@makaio/core';
import type { CallContext, ExtensionName } from '@makaio/core';
import {
  getHostTransactionQueryContext,
  HostTransactionError,
  markTransactionRollbackOnly,
} from '@makaio/storage-drizzle';
import type { JournalContributionProcessor } from './journal-contribution-processor.js';
import {
  appendEntries,
  type AppendEntry,
  type AppendEntryOutcome,
  type AppendSubjectDeclaration,
} from './storage/append-entries.js';
import { moveEdgeCursor, readEdgeCursors } from './storage/edge-cursors.js';
import type { SubjectDirectory } from './subject-directory.js';

/** Host startup barrier for inbound deliveries. */
export interface JournalStartGate {
  /** Wait for host startup to complete. */
  awaitOpen(): Promise<void>;
  /**
   * Check if the caller is running in this extension's unfinished startup.
   * @param extension - Owner of the inbound edge.
   */
  isOwnStartRunning(extension: ExtensionName): boolean;
}

/** Authority for one extension's journal capability. */
export interface JournalCapabilityDependencies {
  readonly extension: ExtensionName;
  readonly bus: IMakaioBus;
  readonly host: HostDatabase;
  readonly subjects: Pick<SubjectDirectory, 'stagedSubjectFor'>;
  readonly contributions: Pick<JournalContributionProcessor, 'edgeFor' | 'stagedEdgeFor' | 'accountResolver'>;
  readonly startGate: JournalStartGate;
  /** Check whether this extension is active. */
  isActive(): boolean;
}

/**
 * Resolve the subject's journal metadata and original runtime payload schema.
 * @param deps - Directory and carrier bus for the recording extension.
 * @param subject - Canonical subject name.
 * @param edge - Live edge restricting a delivery's recorded subjects.
 * @returns The append declaration, or undefined if the subject is unknown.
 */
function resolveSubject(
  deps: JournalCapabilityDependencies,
  subject: SubjectName,
  edge?: InboundEdgeContribution,
): AppendSubjectDeclaration | undefined {
  const declaration = deps.subjects.stagedSubjectFor(subject);
  const registered = deps.bus.getSchema(subject);
  if (declaration === undefined || registered === undefined) return undefined;

  const { schema } = inspectSubjectSchema(registered);
  if (declaration.type !== 'event' || declaration.retention !== 'recorded' || isRequestSchema(schema)) {
    throw new JournalError('subject-not-recorded', `Journal subject "${subject}" is not recorded.`);
  }
  if (declaration.schemaVersion === undefined) {
    throw new Error(`Recorded journal subject "${subject}" has no schema version.`);
  }
  if (edge !== undefined && declaration.extension === deps.extension) assertEdgeSubject(edge, subject);
  return {
    recorded: true,
    owner: declaration.extension,
    schemaVersion: declaration.schemaVersion,
    payloadSchema: schema,
  };
}

/**
 * Resolve an edge for the extension, rejecting an unavailable edge.
 * @param deps - Authority for the recording extension.
 * @param name - Bound edge name.
 * @param lookup - Live or staged edge lookup, depending on the operation.
 * @returns The owned edge definition.
 */
function requireEdge(
  deps: JournalCapabilityDependencies,
  name: EdgeName,
  lookup: 'edgeFor' | 'stagedEdgeFor',
): InboundEdgeContribution {
  const edge = deps.contributions[lookup](deps.extension, name);
  if (edge === undefined) {
    throw new JournalError('edge-unknown', `Journal edge "${name}" is not available to "${deps.extension}".`);
  }
  return edge;
}

/**
 * Verify the edge is declared for this subject.
 * @param edge - Owning extension's live edge.
 * @param subject - Subject submitted through the edge.
 */
function assertEdgeSubject(edge: InboundEdgeContribution, subject: SubjectName): void {
  if (!edge.subjects.includes(subject)) {
    throw new JournalError('edge-unknown', `Journal edge "${edge.edge}" does not accept "${subject}".`);
  }
}

/**
 * Project storage outcomes onto the extension-facing result.
 * @param outcomes - Outcomes supplied by the append store.
 * @returns Public outcomes in input order.
 */
function toRecordOutcomes(outcomes: readonly AppendEntryOutcome[]): EntryRecordOutcome[] {
  return outcomes.map(({ status, row }) => ({ status, entryId: row.entryId }));
}

/**
 * Prepare accepted entries, resolving accounts before the delivery transaction opens.
 * @param deps - Authority for the edge owner.
 * @param entries - Entries submitted by the edge.
 * @returns Entries with verified provenance for the append store.
 */
async function prepareAcceptedEntries(
  deps: JournalCapabilityDependencies,
  entries: readonly AcceptEntryInput[],
): Promise<AppendEntry[]> {
  for (const { witnessed } of entries) {
    if (witnessed !== undefined && witnessed.extension !== deps.extension) {
      throw new JournalError(
        'witnessed-not-owned',
        `Extension "${deps.extension}" cannot witness an account of "${witnessed.extension}".`,
      );
    }
  }
  // ORIGIN: A verified inbound delivery is the edge owner's own work, not a forwarded bus call.
  const { caller, principal } = deps.bus.own('root');
  const resolver = deps.contributions.accountResolver();
  const prepared: AppendEntry[] = [];
  for (const entry of entries) {
    const { witnessed } = entry;
    const origin =
      witnessed === undefined
        ? { caller, principal }
        : {
            caller,
            principal: (await resolver?.resolve(witnessed)) ?? {
              kind: MAKAIO_WITNESSED_ACCOUNT_PARTY_KIND,
              id: `${witnessed.extension}/${witnessed.site}/${witnessed.accountId}`,
            },
            attestedBy: caller,
          };
    prepared.push({ ...entry, origin });
  }
  return prepared;
}

/**
 * Create a lazy handle whose operations resolve the edge when called.
 * @param deps - Authority for the edge owner.
 * @param name - Name bound to the handle.
 * @returns Operations on the named edge.
 */
function createEdgeHandle(deps: JournalCapabilityDependencies, name: EdgeName): JournalEdgeCapability {
  const { extension, host, startGate } = deps;
  return {
    /**
     * @param input - Entries and optional cursor movement.
     * @returns Outcomes after the delivery commits.
     */
    async accept({ entries, cursor }) {
      if (startGate.isOwnStartRunning(extension)) {
        throw new JournalError(
          'accept-during-own-start',
          `Extension "${extension}" cannot accept a delivery during its own startup.`,
        );
      }
      await startGate.awaitOpen();
      const edge = requireEdge(deps, name, 'edgeFor');
      const prepared = await prepareAcceptedEntries(deps, entries);
      const outcomes = await host.transaction(async (tx) => {
        const query = getHostTransactionQueryContext(host, tx);
        const appended = await appendEntries(query, {
          tx,
          extension,
          edge: name,
          entries: prepared,
          subjects: { resolve: (subject) => resolveSubject(deps, subject, edge) },
        });
        if (cursor !== undefined) await moveEdgeCursor(query, { ...cursor, edge: name });
        return appended;
      });
      return toRecordOutcomes(outcomes);
    },
    /**
     * @param partitions - Edge partitions to read.
     * @returns The cursor of each partition, in request order.
     */
    async getEdgeCursors(partitions) {
      requireEdge(deps, name, 'stagedEdgeFor');
      return await host.transaction((tx) =>
        readEdgeCursors(getHostTransactionQueryContext(host, tx), name, partitions),
      );
    },
  };
}

/**
 * Mark the owning facade's live transaction even when journal validation rejected its token.
 * @param tx - Token supplied to the journal.
 * @param error - Error from recording.
 * @throws The recording error, with transaction lookup failures reported as journal errors.
 */
function rejectRecord(tx: HostTransaction, error: unknown): never {
  const tokenRejected =
    error instanceof HostTransactionError &&
    (error.code === 'foreign-transaction' || error.code === 'transaction-finished');
  const failure = tokenRejected ? new JournalError(error.code, error.message, { cause: error }) : error;
  try {
    markTransactionRollbackOnly(
      tx,
      failure instanceof Error ? failure : new Error('Journal record failed.', { cause: failure }),
    );
  } catch (rollbackError) {
    // A token with no live transaction has no rollback target.
    if (!tokenRejected || !(rollbackError instanceof HostTransactionError)) throw rollbackError;
  }
  throw failure;
}

/**
 * Bind the journal write side to one extension and its bus carrier.
 * @param deps - Extension identity, storage and lifecycle dependencies.
 * @returns Journal operations bound to this extension.
 */
export function createJournalCapability(deps: JournalCapabilityDependencies): JournalCapability {
  const { bus, extension, host } = deps;
  const carrier = busCarrierOf(bus);
  const context = busContextOf(bus);
  return {
    /**
     * @param call - Context received or minted by the extension.
     * @param input - Host transaction and entries to record.
     * @returns Outcomes within the caller's transaction.
     */
    async record(call: CallContext, { tx, entries }) {
      try {
        const query = getHostTransactionQueryContext(host, tx);
        if (!deps.isActive()) {
          throw new JournalError('record-before-active', `Extension "${extension}" cannot record before activation.`);
        }
        assertCallCarrier(call, carrier, context);
        const { principal, attestedBy } = call;
        const origin = { caller: carrier, principal, ...(attestedBy === undefined ? {} : { attestedBy }) };
        return toRecordOutcomes(
          await appendEntries(query, {
            tx,
            extension,
            subjects: { resolve: (subject) => resolveSubject(deps, subject) },
            entries: entries.map(({ subject, payload, key, orderKey, edge }) => {
              if (edge !== undefined) assertEdgeSubject(requireEdge(deps, edge, 'edgeFor'), subject);
              return { subject, payload, key, orderKey, edge, origin };
            }),
          }),
        );
      } catch (error) {
        return rejectRecord(tx, error);
      }
    },
    /**
     * @param name - Name bound to the lazy handle.
     * @returns Edge operations that look up the edge at use.
     */
    edge: (name) => createEdgeHandle(deps, name),
  };
}

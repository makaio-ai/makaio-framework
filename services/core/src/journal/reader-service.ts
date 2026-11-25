import type { IHostMakaioBus } from '@makaio/bus-core';
import type { HostDatabase } from '@makaio/contracts';
import { JournalNamespace, type ReaderContribution } from '@makaio/contracts/journal';
import { ContributionNameSchema, localContributionName, type CallContext } from '@makaio/core';
import type { ContributionProcessor, KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import { BaseService } from '@makaio/service-base';
import { getHostDatabaseWake } from '@makaio/storage-drizzle';
import { JournalActivationError } from './journal-contribution-processor.js';
import { requireReaderRequest, resolveReadAccess, type JournalReaderAuthority } from './reader-access.js';
import { JournalReaderRun, readerPatterns } from './reader-run.js';
import { JOURNAL_ENTRIES_WAKE_TOPIC } from './storage/append-entries.js';
import { JournalReaderStore, type ReaderCursorReservation } from './storage/reader-store.js';
import type { SubjectDirectory } from './subject-directory.js';

/** A reader installed and authorized by the host itself. */
interface HostReader {
  readonly contribution: ReaderContribution;
  readonly call: CallContext;
  /** Whether the host reader can admit or claim more work. */
  readonly canSelect?: () => boolean;
}

/** Validated declaration held for the extension's current activation. */
interface ReaderDeclaration {
  readonly owner: string;
  readonly contribution: ReaderContribution;
}

/** Capture registration fields while retaining the original callback receiver.
 * @param declared - Reader provided by the extension.
 * @returns The stable reader definition for this activation.
 */
function snapshotReader(declared: ReaderContribution): ReaderContribution {
  const { reader, description, startAt } = declared;
  return Object.freeze({
    reader,
    description,
    startAt,
    subjects: declared.subjects.bind(declared),
    handle: declared.handle.bind(declared),
  });
}

/** Runs and provisional cursor writes belonging to one extension activation. */
interface ReaderActivation {
  readonly runs: readonly JournalReaderRun[];
  readonly reservations: readonly ReaderCursorReservation[];
}

/** Host components for the journal reader service. */
export interface JournalReaderServiceOptions extends JournalReaderAuthority {
  /** Host bus used for journal requests. */
  readonly bus: IHostMakaioBus;
  /** Database also used to append journal entries. */
  readonly host: HostDatabase;
  /** Directory used to diagnose unreachable subject patterns. */
  readonly directory: SubjectDirectory;
  /** Built-in reader and its kernel-minted identity. */
  readonly hostReader?: HostReader;
}

/** Serve journal queries and run extension readers driven by database wakes. */
export class JournalReaderService extends BaseService implements ContributionProcessor {
  private readonly activations = new Map<string, ReaderActivation>();
  private readonly declarations = new Map<string, ReaderDeclaration>();
  private hostRun?: JournalReaderRun;
  private readonly store: JournalReaderStore;
  private running = false;

  /**
   * @param options - Host bus, database, and authority for stored rows.
   */
  public constructor(private readonly options: JournalReaderServiceOptions) {
    super(options.bus);
    this.store = new JournalReaderStore(options.host);
  }

  /** Register read handlers and subscribe to local commits and database signals. */
  protected async onInit(): Promise<void> {
    const { subjects: journal } = this.options.bus.registerNamespace(JournalNamespace);
    this.registerHandler(journal.entries, async ({ call, payload, setResult }) => {
      this.requireRunning();
      setResult(
        await this.store.readEntries(
          payload,
          async (entry) => (await resolveReadAccess(this.options, call, entry)).granted,
        ),
      );
    });
    const readerStates = journal['reader-states'];
    this.registerHandler(readerStates, async ({ call, payload, setResult }) => {
      this.requireRunning();
      const request = Object.freeze(structuredClone(payload));
      await requireReaderRequest(
        this.options,
        call,
        `${readerStates.$meta.namespace}.${readerStates.subject}`,
        request,
      );
      setResult(await this.store.getReaderStates(request));
    });
    this.registerHandler(journal.reprocess, async ({ call, payload, setResult }) => {
      this.requireRunning();
      const request = structuredClone(payload);
      await requireReaderRequest(
        this.options,
        call,
        `${journal.reprocess.$meta.namespace}.${journal.reprocess.subject}`,
        request,
      );
      const result = await this.store.reprocess(request);
      if (result.success) this.wake();
      setResult(result);
    });
    const databaseWake = getHostDatabaseWake(this.options.host);
    const wake = this.wake.bind(this);
    this.addCleanup(databaseWake.subscribe(JOURNAL_ENTRIES_WAKE_TOPIC, wake));
    this.addCleanup(databaseWake.onResync(wake));
    const hostReader = this.options.hostReader;
    if (hostReader) {
      const { contribution, call } = hostReader;
      const [cursor] = await this.store.initialize(call.caller.id, [contribution]);
      if (!cursor) throw new Error('The host reader has no cursor.');
      this.hostRun = new JournalReaderRun(contribution, this.store, this.options, {
        call,
        cursor,
        isActive: () => this.running,
        canSelect: hostReader.canSelect,
      });
    }
    void databaseWake.ready().then(wake, () => console.error('[Journal] Database wake unavailable'));
  }

  /** Enable requests and recover outstanding work after all extensions have started. */
  public start(): void {
    this.running = true;
    this.wake();
  }

  /** Request a selection for every active reader. */
  public wake(): void {
    if (!this.running) return;
    this.hostRun?.wake();
    for (const { runs } of this.activations.values()) {
      for (const reader of runs) reader.wake();
    }
  }

  /** Disable requests and drain database operations from previous attempts. */
  protected async onDestroy(): Promise<void> {
    this.running = false;
    await Promise.all([
      this.hostRun?.close(),
      ...[...this.activations.keys()].map((owner) => this.processStopped(owner)),
    ]);
    this.hostRun = undefined;
    this.declarations.clear();
  }

  /** Reject queries until startup has installed all rights sources. */
  private requireRunning(): void {
    if (!this.running) throw new Error('The journal reader service is not running.');
  }

  /**
   * Validate and reserve all reader names before extension initialization.
   * @param owner - Declaring extension.
   * @param pkg - Manifest whose names and subject patterns are validated.
   */
  public processActivating(owner: string, pkg: KernelMakaioExtension): void {
    const staged = new Map<string, ReaderDeclaration>();
    for (const declared of pkg.readers ?? []) {
      const contribution = snapshotReader(declared);
      const { reader } = contribution;
      if (!ContributionNameSchema.safeParse(reader).success || localContributionName(owner, reader) === undefined) {
        throw new Error(`Invalid reader name "${reader}" for extension "${owner}".`);
      }
      if (staged.has(reader)) throw new Error(`Duplicate reader "${reader}".`);
      if (reader === this.options.hostReader?.contribution.reader) {
        throw new JournalActivationError('duplicate-reader', owner, reader, 'The reader name is reserved by the host');
      }
      const reservedBy = this.declarations.get(reader)?.owner;
      if (reservedBy !== undefined && reservedBy !== owner) {
        throw new JournalActivationError(
          'duplicate-reader',
          owner,
          reader,
          `Extension "${reservedBy}" already declares this reader`,
        );
      }
      readerPatterns(contribution);
      staged.set(reader, { owner, contribution });
    }
    for (const [reader, declaration] of staged) this.declarations.set(reader, declaration);
  }

  /**
   * Reserve all durable reader cursors before staging the runs.
   * @param owner - Declaring extension.
   * @param _pkg - Manifest supplied by the coordinator.
   * @param ctx - Context of the activating extension.
   */
  public async processActivated(
    owner: string,
    _pkg: KernelMakaioExtension,
    ctx: KernelExtensionContext,
  ): Promise<void> {
    const contributions = new Map(
      [...this.declarations.values()]
        .filter((declaration) => declaration.owner === owner)
        .map(({ contribution }) => [contribution.reader, contribution] as const),
    );
    if (contributions.size === 0) return;
    const activation = { call: ctx.bus.own('schedule'), isActive: () => ctx.hasExtension(owner) };
    const reservations = await this.store.initialize(owner, [...contributions.values()]);
    const runs = reservations.map((cursor) => {
      const contribution = contributions.get(cursor.reader);
      if (!contribution) throw new Error('The reserved reader has no declaration.');
      return new JournalReaderRun(contribution, this.store, this.options, { ...activation, cursor });
    });
    this.activations.set(owner, { runs, reservations });
  }

  /**
   * Remove this generation and release its names after draining its database work.
   * @param owner - Extension stopping.
   * @returns Completion of reader teardown.
   */
  public processStopped(owner: string): Promise<void> {
    return this.releaseActivation(owner, false);
  }

  /**
   * Undo the reservations made for a generation that failed to activate.
   * @param owner - Extension whose activation failed.
   * @returns Completion of reader teardown and reservation rollback.
   */
  public processActivationRollback(owner: string): Promise<void> {
    return this.releaseActivation(owner, true);
  }

  /**
   * Remove the runs, optionally compensating for provisional cursor writes.
   * @param owner - Declaring extension.
   * @param rollback - Whether the extension failed to activate.
   */
  private async releaseActivation(owner: string, rollback: boolean): Promise<void> {
    const activation = this.activations.get(owner);
    this.activations.delete(owner);
    try {
      if (activation) {
        await Promise.all(activation.runs.map((reader) => reader.close()));
        if (rollback) await this.store.rollbackReservation(activation.reservations);
      }
    } finally {
      for (const [reader, declaration] of this.declarations) {
        if (declaration.owner === owner) this.declarations.delete(reader);
      }
    }
  }
}

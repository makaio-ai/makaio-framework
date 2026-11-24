import type { IHostMakaioBus } from '@makaio/bus-core';
import type { HostDatabase } from '@makaio/contracts';
import { JournalNamespace } from '@makaio/contracts/journal';
import { ContributionNameSchema, localContributionName } from '@makaio/core';
import type { ContributionProcessor, KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import { BaseService } from '@makaio/service-base';
import { getHostDatabaseWake } from '@makaio/storage-drizzle';
import { JournalActivationError } from './journal-contribution-processor.js';
import { requireReprocess, resolveReadAccess, type JournalReaderAuthority } from './reader-access.js';
import { JournalReaderRun, readerPatterns } from './reader-run.js';
import { JOURNAL_ENTRIES_WAKE_TOPIC } from './storage/append-entries.js';
import { JournalReaderStore } from './storage/reader-store.js';
import type { SubjectDirectory } from './subject-directory.js';

/** Host components for the journal reader service. */
export interface JournalReaderServiceOptions extends JournalReaderAuthority {
  /** Host bus used for journal requests. */
  readonly bus: IHostMakaioBus;
  /** Database also used to append journal entries. */
  readonly host: HostDatabase;
  /** Directory used to diagnose unreachable subject patterns. */
  readonly directory: SubjectDirectory;
}

/** Serve journal queries and run extension readers driven by database wakes. */
export class JournalReaderService extends BaseService implements ContributionProcessor {
  private readonly runs = new Map<string, JournalReaderRun[]>();
  private readonly readerOwners = new Map<string, string>();
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
  protected onInit(): void {
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
    this.registerHandler(journal['reader-states'], async ({ payload, setResult }) => {
      this.requireRunning();
      setResult(await this.store.getReaderStates(payload));
    });
    this.registerHandler(journal.reprocess, async ({ call, payload, setResult }) => {
      this.requireRunning();
      await requireReprocess(
        this.options,
        call,
        `${journal.reprocess.$meta.namespace}.${journal.reprocess.subject}`,
        payload,
      );
      const result = await this.store.reprocess(payload);
      if (result.success) this.wake();
      setResult(result);
    });
    const databaseWake = getHostDatabaseWake(this.options.host);
    const wake = this.wake.bind(this);
    this.addCleanup(databaseWake.subscribe(JOURNAL_ENTRIES_WAKE_TOPIC, wake));
    this.addCleanup(databaseWake.onResync(wake));
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
    for (const readers of this.runs.values()) {
      for (const reader of readers) reader.wake();
    }
  }

  /** Disable requests and drain database operations from previous attempts. */
  protected async onDestroy(): Promise<void> {
    this.running = false;
    await Promise.all([...this.runs.keys()].map((owner) => this.processStopped(owner)));
    this.readerOwners.clear();
  }

  /** Reject queries until startup has installed all rights sources. */
  private requireRunning(): void {
    if (!this.running) throw new Error('The journal reader service is not running.');
  }

  /**
   * @param pkg - Manifest to check.
   * @returns Whether the extension declares readers.
   */
  public filter(pkg: KernelMakaioExtension): boolean {
    return Boolean(pkg.readers?.length);
  }

  /**
   * Validate and reserve all reader names before extension initialization.
   * @param owner - Declaring extension.
   * @param pkg - Manifest whose names and subject patterns are validated.
   */
  public processActivating(owner: string, pkg: KernelMakaioExtension): void {
    const names = new Set<string>();
    for (const contribution of pkg.readers ?? []) {
      const { reader } = contribution;
      if (!ContributionNameSchema.safeParse(reader).success || localContributionName(owner, reader) === undefined) {
        throw new Error(`Invalid reader name "${reader}" for extension "${owner}".`);
      }
      if (names.has(reader)) throw new Error(`Duplicate reader "${reader}".`);
      const reservedBy = this.readerOwners.get(reader);
      if (reservedBy !== undefined && reservedBy !== owner) {
        throw new JournalActivationError(
          'duplicate-reader',
          owner,
          reader,
          `Extension "${reservedBy}" already declares this reader`,
        );
      }
      names.add(reader);
      readerPatterns(contribution);
    }
    for (const reader of names) this.readerOwners.set(reader, owner);
  }

  /**
   * Stage definitions and capture the head at activation.
   * Persist the starting frontier only when the coordinator confirms activation.
   * @param owner - Declaring extension.
   * @param pkg - Manifest supplying the readers.
   * @param ctx - Context of the activating extension.
   */
  public async processActivated(owner: string, pkg: KernelMakaioExtension, ctx: KernelExtensionContext): Promise<void> {
    const contributions = pkg.readers ?? [];
    const position = contributions.some(({ startAt }) => startAt !== 'beginning') ? await this.store.head() : 0;
    const activation = { position, call: ctx.bus.own('schedule'), isActive: () => ctx.hasExtension(owner) };
    this.runs.set(
      owner,
      contributions.map((contribution) => new JournalReaderRun(contribution, this.store, this.options, activation)),
    );
  }

  /**
   * Remove this generation and release its names after draining its database work.
   * @param owner - Extension stopping or rolling back activation.
   */
  public async processStopped(owner: string): Promise<void> {
    const readers = this.runs.get(owner) ?? [];
    this.runs.delete(owner);
    await Promise.all(readers.map((reader) => reader.close()));
    for (const [reader, reservedBy] of this.readerOwners) {
      if (reservedBy === owner) this.readerOwners.delete(reader);
    }
  }
}

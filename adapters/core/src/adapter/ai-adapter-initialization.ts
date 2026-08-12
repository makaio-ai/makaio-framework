import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type ConnectorTeardownResult } from '@makaio/contracts';

type AdapterLifecycleState = 'new' | 'initializing' | 'initialized' | 'closing' | 'closed';

/** Operations owned by an adapter and serialized by its lifecycle coordinator. */
export interface AdapterLifecycleOperations {
  /** Prepare admission for a new generation without starting resources. */
  readonly prepareInitialization: () => void;
  /** Install handlers and initialize subclass resources. */
  readonly initialize: () => Promise<void>;
  /** Fully tear down one admitted generation. */
  readonly shutdown: (publishWithdrawal: boolean) => Promise<ConnectorTeardownResult>;
  /** Bus carrying lifecycle publications. */
  readonly bus: IMakaioBus;
  /** Exact initialized event for this adapter instance. */
  readonly publication: InitializedAdapterPublication;
}

/**
 * Serialize lifecycle calls in invocation order while joining adjacent calls of
 * the same kind. An opposite operation is a generation boundary and therefore
 * always queues a distinct flight behind its predecessor.
 */
export class AdapterLifecycleCoordinator {
  private state: AdapterLifecycleState = 'new';
  private operationTail: Promise<void> = Promise.resolve();
  private lastOperation: 'init' | 'close' | undefined;
  private initFlight: Promise<void> | undefined;
  private closeFlight: Promise<ConnectorTeardownResult> | undefined;
  private lastCloseReport: ConnectorTeardownResult = { evidence: 'released' };

  public constructor(private readonly operations: AdapterLifecycleOperations) {}

  /**
   * Initialize or join the active initialization flight.
   * @returns Promise settled when the adapter is publicly initialized
   */
  public init(): Promise<void> {
    if (this.lastOperation === 'init' && this.initFlight !== undefined) return this.initFlight;
    const flight = this.operationTail.then(() => this.runInitialization());
    this.lastOperation = 'init';
    this.initFlight = flight;
    this.operationTail = flight.then(
      () => undefined,
      () => undefined,
    );
    void flight.catch(() => {
      if (this.initFlight !== flight) return;
      this.initFlight = undefined;
      if (this.lastOperation === 'init') this.lastOperation = undefined;
    });
    return flight;
  }

  /**
   * Close or join the current generation's shutdown flight.
   * @returns The generation's cached teardown report
   */
  public close(): Promise<ConnectorTeardownResult> {
    if (this.lastOperation === 'close' && this.closeFlight !== undefined) return this.closeFlight;
    const flight = this.operationTail.then(() => this.runClose());
    this.lastOperation = 'close';
    this.closeFlight = flight;
    this.operationTail = flight.then(
      () => undefined,
      () => undefined,
    );
    void flight.catch(() => {
      if (this.closeFlight !== flight) return;
      this.closeFlight = undefined;
      if (this.lastOperation === 'close') this.lastOperation = undefined;
    });
    return flight;
  }

  /** @returns Whether the current generation is publicly initialized */
  public isInitialized(): boolean {
    return this.state === 'initialized';
  }

  private async runInitialization(): Promise<void> {
    if (this.state === 'initialized') return;
    if (this.state === 'closing') await this.completeShutdown(false);
    this.operations.prepareInitialization();
    this.state = 'initializing';
    let publicationAttempted = false;
    try {
      await this.operations.initialize();
      // An emit can reject after earlier local observers already saw the adapter
      // as live, so every started publication attempt requires compensating
      // best-effort withdrawal if initialization cannot commit.
      publicationAttempted = true;
      await publishInitializedAdapter(this.operations.bus, this.operations.publication);
      this.state = 'initialized';
    } catch (initializationError) {
      try {
        await this.completeShutdown(publicationAttempted);
      } catch (shutdownError) {
        throw new AggregateError([initializationError, shutdownError], 'Adapter initialization and rollback failed');
      }
      throw initializationError;
    }
  }

  private async runClose(): Promise<ConnectorTeardownResult> {
    if (this.state === 'closed') return this.lastCloseReport;
    const publishWithdrawal = this.state === 'initialized';
    return this.completeShutdown(publishWithdrawal);
  }

  private async completeShutdown(publishWithdrawal: boolean): Promise<ConnectorTeardownResult> {
    this.state = 'closing';
    this.lastCloseReport = await this.operations.shutdown(publishWithdrawal);
    this.state = 'closed';
    return this.lastCloseReport;
  }
}

/** Payload used to announce one initialized adapter instance. */
export interface InitializedAdapterPublication {
  /** Exact runtime adapter instance ID. */
  readonly adapterId: string;
  /** Stable adapter implementation name. */
  readonly adapterName: string;
  /** Canonical machine hosting the instance. */
  readonly machineId: string;
  /** Exact ownership-authority incarnation hosting this instance. */
  readonly ownerInstanceId: string;
  /** Capabilities the initialized instance implements. */
  readonly capabilities: string[];
  /** Native tools provided by the instance. */
  readonly nativeTools: string[];
}

/** Public identity fields exposed by a live adapter instance. */
export interface LiveAdapterIdentitySource {
  /** Exact runtime adapter instance ID. */
  readonly adapterId: string;
  /** Stable adapter implementation name. */
  readonly name: string;
  /** Canonical machine hosting the instance. */
  readonly machineId: string;
  /** Exact ownership-authority incarnation hosting this instance. */
  readonly ownerInstanceId: string;
}

/**
 * Require the machine identity needed to make initialization announcements
 * usable as live dispatch proofs.
 * @param adapterName - Adapter whose host identity is required.
 * @param machineId - Host-composed machine identity.
 * @returns The present machine identity.
 */
export function requireAdapterMachineId(adapterName: string, machineId: string | undefined): string {
  if (machineId === undefined || machineId.trim() === '') {
    throw new Error(`AIAdapter ${adapterName} requires a machine identity before announcing initialization`);
  }
  return machineId;
}

/**
 * Publish the exact live identity of an initialized adapter instance.
 * @param bus - Global bus that carries adapter lifecycle events.
 * @param publication - Complete, machine-scoped adapter identity and metadata.
 */
export async function publishInitializedAdapter(
  bus: IMakaioBus,
  publication: InitializedAdapterPublication,
): Promise<void> {
  await bus.emit(AdapterSubjects.initialized, publication);
}

/**
 * Publish withdrawal of one previously initialized adapter instance.
 * @param bus - Global bus that carries adapter lifecycle events.
 * @param adapter - Live adapter identity that is being withdrawn.
 */
export async function publishDeinitializedAdapter(bus: IMakaioBus, adapter: LiveAdapterIdentitySource): Promise<void> {
  await bus.emit(AdapterSubjects.deinitialized, {
    adapterId: adapter.adapterId,
    adapterName: adapter.name,
    machineId: adapter.machineId,
    ownerInstanceId: adapter.ownerInstanceId,
  });
}

/**
 * Publish adapter withdrawal without allowing an observer failure to block adapter cleanup.
 * @param bus - Global bus that carries adapter lifecycle events.
 * @param adapter - Live adapter identity that is being withdrawn.
 * @returns A promise that settles after publication succeeds or its failure is reported.
 */
export async function publishDeinitializedAdapterBestEffort(
  bus: IMakaioBus,
  adapter: LiveAdapterIdentitySource,
): Promise<void> {
  try {
    await publishDeinitializedAdapter(bus, adapter);
  } catch (error) {
    console.warn(`[AIAdapter] Failed to publish deinitialization for ${adapter.name}:`, error);
  }
}

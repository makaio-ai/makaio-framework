import type { IMakaioBus } from '@makaio/bus-core';
import { BootSubjects } from '../boot-namespace.js';

/** Package identity fields needed for boot progress events. */
export interface BootProgressPackage {
  /** Runtime package name. */
  readonly name: string;
  /** Human-readable package display name. */
  readonly displayName: string;
}

/** Mutable boot progress state served through {@link BootSubjects.getState}. */
interface BootProgressState {
  /** Whether package boot has completed. */
  complete: boolean;
  /** Number of packages that have settled. */
  completedCount: number;
  /** Total number of packages participating in this boot. */
  totalCount: number;
  /** Display name of the package currently starting. */
  currentService?: string;
  /** Timestamp for the currently starting package. */
  currentServiceStartedAt?: number;
  /** Packages that failed during startup. */
  failedServices: string[];
  /** Packages that skipped startup intentionally. */
  skippedServices: string[];
  /** Epoch millisecond timestamp for boot start. */
  startedAt: number;
  /** Total package boot duration after completion. */
  totalDurationMs?: number;
}

/**
 * Create the serializable service identity emitted through boot subjects.
 * @param pkg - Package metadata supplied by the extension coordinator.
 * @returns Stable boot-service identity payload.
 */
function toBootServiceIdentity(pkg: BootProgressPackage): BootProgressPackage {
  return {
    name: pkg.name,
    displayName: pkg.displayName,
  };
}

/** Emits kernel boot namespace events while the extension coordinator starts packages. */
export class BootProgressObserver {
  private readonly state: BootProgressState;
  private readonly cleanup: () => void;

  /**
   * @param bus - Bus used for boot events and state RPC.
   * @param totalCount - Total packages in this startup sequence.
   */
  public constructor(
    private readonly bus: IMakaioBus,
    totalCount: number,
  ) {
    this.state = {
      complete: false,
      completedCount: 0,
      totalCount,
      failedServices: [],
      skippedServices: [],
      startedAt: Date.now(),
    };
    this.cleanup = this.bus.on(BootSubjects.getState, (ctx) => {
      ctx.setResult({
        complete: this.state.complete,
        completedCount: this.state.completedCount,
        totalCount: this.state.totalCount,
        ...(this.state.currentService !== undefined ? { currentService: this.state.currentService } : {}),
        failedServices: [...this.state.failedServices],
        skippedServices: [...this.state.skippedServices],
        ...(this.state.totalDurationMs !== undefined ? { totalDurationMs: this.state.totalDurationMs } : {}),
      });
    });
  }

  /** Unregister the boot state RPC handler. */
  public dispose(): void {
    this.cleanup();
  }

  /**
   * Record a package that is beginning startup.
   * @param pkg - Package identity.
   */
  public starting(pkg: BootProgressPackage): void {
    const identity = toBootServiceIdentity(pkg);
    this.state.currentService = identity.displayName;
    this.state.currentServiceStartedAt = Date.now();
    void this.bus.emit(BootSubjects.service.starting, identity).catch((err: unknown) => {
      console.warn(`[ExtensionCoordinator] boot.service.starting emit failed for "${identity.name}":`, err);
    });
  }

  /**
   * Record a package that reached the active state.
   * @param pkg - Package identity.
   */
  public ready(pkg: BootProgressPackage): void {
    const identity = toBootServiceIdentity(pkg);
    this.state.completedCount += 1;
    const durationMs =
      this.state.currentServiceStartedAt !== undefined
        ? Math.max(0, Date.now() - this.state.currentServiceStartedAt)
        : 0;
    void this.bus.emit(BootSubjects.service.ready, { ...identity, durationMs }).catch((err: unknown) => {
      console.warn(`[ExtensionCoordinator] boot.service.ready emit failed for "${identity.name}":`, err);
    });
    this.emitProgress();
  }

  /**
   * Record a package that failed startup.
   * @param pkg - Package identity.
   * @param errorMessage - Human-readable failure reason.
   */
  public failed(pkg: BootProgressPackage, errorMessage: string): void {
    const identity = toBootServiceIdentity(pkg);
    this.state.completedCount += 1;
    this.state.failedServices.push(identity.name);
    void this.bus.emit(BootSubjects.service.failed, { ...identity, errorMessage }).catch((err: unknown) => {
      console.warn(`[ExtensionCoordinator] boot.service.failed emit failed for "${identity.name}":`, err);
    });
    this.emitProgress();
  }

  /**
   * Record a package that intentionally skipped startup.
   * @param pkg - Package identity.
   * @param reason - Human-readable skip reason.
   */
  public skipped(pkg: BootProgressPackage, reason: string): void {
    const identity = toBootServiceIdentity(pkg);
    this.state.completedCount += 1;
    this.state.skippedServices.push(identity.name);
    void this.bus.emit(BootSubjects.service.skipped, { ...identity, reason }).catch((err: unknown) => {
      console.warn(`[ExtensionCoordinator] boot.service.skipped emit failed for "${identity.name}":`, err);
    });
    this.emitProgress();
  }

  /** Record coordinator package boot completion. */
  public complete(): void {
    this.state.complete = true;
    delete this.state.currentService;
    delete this.state.currentServiceStartedAt;
    this.state.totalDurationMs = Date.now() - this.state.startedAt;
    void this.bus
      .emit(BootSubjects.complete, {
        totalDurationMs: this.state.totalDurationMs,
        failedServices: [...this.state.failedServices],
      })
      .catch((err: unknown) => {
        console.warn('[ExtensionCoordinator] boot.complete emit failed:', err);
      });
  }

  /** Emit current aggregate boot progress. */
  private emitProgress(): void {
    void this.bus
      .emit(BootSubjects.progress, {
        completedCount: this.state.completedCount,
        totalCount: this.state.totalCount,
        ...(this.state.currentService !== undefined ? { currentService: this.state.currentService } : {}),
      })
      .catch((err: unknown) => {
        console.warn('[ExtensionCoordinator] boot.progress emit failed:', err);
      });
  }
}

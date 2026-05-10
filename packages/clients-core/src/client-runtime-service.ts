import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import {
  ClientSubjects,
  type ClientAccountIdentifier,
  type ClientScanTarget,
  type ClientScanResult,
  type ClientUsageIngestRequest,
  type ClientUsageSnapshot,
} from '@makaio/contracts/client';
import { type ContextForSubjectDefinition } from '@makaio/core';
import { BaseService } from '@makaio/service-base';
import { CLIDetectionSubjects, type CLIDetectionResult } from '@makaio/services-core/cli-detection/namespace';
import { ClientStorageSubjects, type ClientRecord } from '@makaio/services-core/settings/storage';
import { ClientAccountRegistry } from './client-account-registry.js';
import { ClientRuntimeRegistry } from './client-runtime-registry.js';
import { canonicalizeClientId } from './client-session-observed-semantics.js';
import { createClientWiringListSubjectDef } from './create-client-wiring-list-subject.js';
import { assertAbsoluteProjectDir, type ClientWiringAggregatedResult } from './wiring-schemas.js';

type ScannableClientRecord = ClientRecord & { binaryName: string };
type ScannableClient = Pick<ClientScanTarget, 'clientId' | 'binaryName' | 'minimumVersion'>;

/**
 * In-memory shape for an active account identity record.
 */
interface ActiveIdentityRecord {
  clientAccountId: string;
  identifiers: ClientAccountIdentifier[];
  displayLabel?: string;
}

/**
 * In-memory runtime service for the global `client.*` contracts.
 *
 * The service owns six concerns:
 * - account identity canonicalization via {@link ClientAccountRegistry}
 * - latest usage snapshot retention and `client.usage.snapshot` emission
 * - active account identity tracking (`account.activate` / `account.getActive`)
 * - CLI-backed client discovery via storage + CLI detection orchestration
 * - client runtime instance lifecycle via {@link ClientRuntimeRegistry}
 * - global wiring aggregation via `client.wiring.list` fan-out to enabled clients
 */
export class ClientRuntimeService extends BaseService {
  private readonly latestSnapshots = new Map<string, ClientUsageSnapshot>();

  /**
   * Most recently activated account identity per client, keyed by `clientId`.
   *
   * Populated by the `account.activate` handler and queried by `account.getActive`.
   * This allows services (e.g. the Claude Code client) to resolve an active
   * account identity without requiring a persisted session.
   */
  private readonly activeIdentities = new Map<string, ActiveIdentityRecord>();

  /**
   * Creates a new client runtime service.
   * @param bus - Bus instance used for client request/event handling
   * @param accountRegistry - In-memory account registry implementation
   * @param runtimeRegistry - Registry for client runtime instance lifecycle
   */
  public constructor(
    bus: IMakaioBus = MakaioBus,
    private readonly accountRegistry: ClientAccountRegistry = new ClientAccountRegistry(),
    private readonly runtimeRegistry: ClientRuntimeRegistry = new ClientRuntimeRegistry(bus),
  ) {
    super(bus);
  }

  /**
   * Register client runtime handlers on the bus.
   */
  protected override async onInit(): Promise<void> {
    await this.runtimeRegistry.loadFromStorage();
    this.registerHandler(ClientSubjects.account.observe, (ctx) => this.handleAccountObserve(ctx));
    this.registerHandler(ClientSubjects.usage.ingest, (ctx) => this.handleUsageIngest(ctx));
    this.registerHandler(ClientSubjects.scan, async (ctx) => {
      const results = await this.scanClients(ctx.payload.targets);
      ctx.setResult({ results });
    });
    this.registerHandler(ClientSubjects.runtime.observe, (ctx) => this.handleRuntimeObserve(ctx));
    this.registerHandler(ClientSubjects.wiring.list, async (ctx) => {
      const results = await this.listWirings(ctx.payload);
      ctx.setResult({ results });
    });
    this.registerHandler(ClientSubjects.account.activate, (ctx) => {
      this.activeIdentities.set(ctx.payload.clientId, {
        clientAccountId: ctx.payload.clientAccountId,
        identifiers: ctx.payload.identifiers,
        displayLabel: ctx.payload.displayLabel,
      });
      ctx.setResult({ accepted: true });
    });
    this.registerHandler(ClientSubjects.account.getActive, (ctx) => {
      const found = this.activeIdentities.get(ctx.payload.clientId);
      ctx.setResult({ identity: found ?? null });
    });
  }

  /**
   * Clear all in-memory state on destroy.
   */
  protected override onDestroy(): void {
    this.latestSnapshots.clear();
    this.activeIdentities.clear();
    this.accountRegistry.clear();
    this.runtimeRegistry.clear();
  }

  /**
   * Return the latest snapshot retained for an account, if one exists.
   * @param clientAccountId - Canonical account ID
   * @returns Latest snapshot or undefined
   */
  public getLatestSnapshot(clientAccountId: string): ClientUsageSnapshot | undefined {
    return this.latestSnapshots.get(clientAccountId);
  }

  private async handleAccountObserve(
    ctx: ContextForSubjectDefinition<typeof ClientSubjects.account.observe>,
  ): Promise<void> {
    const result = this.accountRegistry.upsertAccount({
      clientId: ctx.payload.clientId,
      identifiers: ctx.payload.identifiers,
      displayLabel: ctx.payload.displayLabel,
    });
    const existingSnapshot = this.latestSnapshots.get(result.clientAccountId);
    const consolidatedSnapshot = this.consolidateMergedSnapshots(result.clientAccountId, result.mergedAccountIds);
    const refreshedSnapshot = withDisplayLabel(consolidatedSnapshot ?? existingSnapshot, result.displayLabel);
    if (refreshedSnapshot) {
      this.latestSnapshots.set(result.clientAccountId, refreshedSnapshot);
    }
    if (refreshedSnapshot && (result.mergedAccountIds.length > 0 || refreshedSnapshot !== existingSnapshot)) {
      await this.bus.emit(ClientSubjects.usage.snapshot, refreshedSnapshot);
    }
    ctx.setResult({
      clientAccountId: result.clientAccountId,
      displayLabel: result.displayLabel,
    });
  }

  private async handleUsageIngest(ctx: ContextForSubjectDefinition<typeof ClientSubjects.usage.ingest>): Promise<void> {
    const result = this.accountRegistry.upsertAccount({
      clientId: ctx.payload.clientId,
      identifiers: ctx.payload.account.identifiers,
      displayLabel: ctx.payload.account.displayLabel,
    });
    this.consolidateMergedSnapshots(result.clientAccountId, result.mergedAccountIds);

    const ingestedSnapshot = createUsageSnapshot(result.clientAccountId, ctx.payload, result.displayLabel);
    const snapshot = withDisplayLabel(
      selectLatestSnapshot(this.latestSnapshots.get(result.clientAccountId), ingestedSnapshot),
      result.displayLabel,
    );
    this.latestSnapshots.set(result.clientAccountId, snapshot);

    await this.bus.emit(ClientSubjects.usage.snapshot, snapshot);
    ctx.setResult({
      clientAccountId: result.clientAccountId,
      snapshot,
    });
  }

  private async handleRuntimeObserve(
    ctx: ContextForSubjectDefinition<typeof ClientSubjects.runtime.observe>,
  ): Promise<void> {
    const { payload } = ctx;

    // Defense-in-depth: the Zod schema has a .refine() for this invariant, but
    // bus-core schema validation is dev-only and skipped in production. Guard
    // here so the invariant is enforced regardless of runtime mode.
    if (
      payload.supervisorSessionId === undefined &&
      payload.pid === undefined &&
      payload.adapterSessionId === undefined
    ) {
      throw new Error(
        'client.runtime.observe: at least one hard-evidence field is required ' +
          '(supervisorSessionId, pid, or adapterSessionId)',
      );
    }

    const { record, ...result } = await this.runtimeRegistry.upsertRuntime(payload);

    if (result.created || result.promoted) {
      await this.bus.emit(ClientSubjects.runtime.started, {
        clientRuntimeId: record.clientRuntimeId,
        clientId: record.clientId,
        status: record.status,
        source: payload.source,
        observedAt: payload.observedAt,
        supervisorSessionId: record.supervisorSessionId,
        pid: record.pid,
        parentPid: record.parentPid,
        adapterSessionId: record.adapterSessionId,
        sessionId: record.sessionId,
        cwd: record.cwd,
        argv: record.argv,
        metadata: record.metadata,
      });
    }

    ctx.setResult({
      clientRuntimeId: result.clientRuntimeId,
      created: result.created,
      promoted: result.promoted,
    });
  }

  private async scanClients(targets?: readonly ClientScanTarget[]): Promise<ClientScanResult[]> {
    const scannableClients = targets ?? (await this.listScannableStoredClients());

    if (scannableClients.length === 0) {
      return [];
    }

    const binaries = Array.from(new Set(scannableClients.map((client) => client.binaryName)));
    const { results: detectionResults } = await this.bus.request(CLIDetectionSubjects.scan, {
      binaries,
    });
    const detectionsByBinary = new Map<string, CLIDetectionResult>(
      detectionResults.map((detectionResult) => [detectionResult.binary, detectionResult]),
    );

    return scannableClients.map((client) => {
      const detection = detectionsByBinary.get(client.binaryName);
      const found = detection?.found ?? false;
      const version = detection?.version;

      return {
        clientId: client.clientId,
        found,
        version,
        warningMessage: resolveWarningMessage(found, version, client.minimumVersion),
      };
    });
  }

  private async listScannableStoredClients(): Promise<ScannableClient[]> {
    const { clients } = await this.bus.request(ClientStorageSubjects.list, {});
    return clients.filter(isScannableClientRecord).map((client) => ({
      clientId: client.id,
      binaryName: client.binaryName,
      minimumVersion: client.minimumVersion,
    }));
  }

  /**
   * Fan out a `wiring.list` request to each enabled client and aggregate the
   * results.
   *
   * Only enabled clients respond; clients whose per-client `wiring.list`
   * handler is not registered are skipped via `requestOptional`, and clients
   * whose handler throws (I/O error, timeout, etc.) are omitted with a
   * warning so that one failing client does not break status for the rest.
   *
   * The `payload` object accepts three optional filter fields:
   * - `clientId` — when present, only the matching client is queried.
   * - `projectDir` — forwarded verbatim to each per-client handler.
   * - `makaioCommand` — forwarded verbatim to each per-client handler.
   * @param payload - Filtering options forwarded to each per-client handler.
   * @returns Aggregated wiring results for all responding enabled clients.
   */
  private async listWirings(payload: {
    clientId?: string;
    projectDir?: string;
    makaioCommand: string;
  }): Promise<ClientWiringAggregatedResult[]> {
    assertAbsoluteProjectDir(payload.projectDir);
    const { clients } = await this.bus.request(ClientStorageSubjects.list, {});
    const canonicalClientId =
      payload.clientId !== undefined ? canonicalizeClientId(payload.clientId, 'listWirings') : undefined;
    const targets = clients
      .filter((c) => c.enabled)
      .filter((c) => canonicalClientId === undefined || c.id === canonicalClientId);

    const settled = await Promise.allSettled(
      targets.map(async (client) => {
        const subject = createClientWiringListSubjectDef(client.id);
        const result = await this.bus.requestOptional(subject, {
          projectDir: payload.projectDir,
          makaioCommand: payload.makaioCommand,
        });
        return result.handled ? ({ clientId: client.id, entries: result.data.entries } as const) : null;
      }),
    );
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[ClientRuntimeService] wiring.list for ${targets[i].id} failed: ${reason}`);
      }
    }

    return settled
      .filter((r): r is PromiseFulfilledResult<ClientWiringAggregatedResult | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((r): r is ClientWiringAggregatedResult => r !== null);
  }

  private consolidateMergedSnapshots(
    canonicalAccountId: string,
    mergedAccountIds: ReadonlyArray<string>,
  ): ClientUsageSnapshot | undefined {
    let canonicalSnapshot = this.latestSnapshots.get(canonicalAccountId);
    let didMergeSnapshot = false;

    for (const mergedAccountId of mergedAccountIds) {
      if (mergedAccountId === canonicalAccountId) {
        continue;
      }

      const mergedSnapshot = this.latestSnapshots.get(mergedAccountId);
      if (
        mergedSnapshot &&
        (canonicalSnapshot === undefined || mergedSnapshot.observedAt > canonicalSnapshot.observedAt)
      ) {
        canonicalSnapshot = {
          ...mergedSnapshot,
          clientAccountId: canonicalAccountId,
        };
        didMergeSnapshot = true;
      }

      this.latestSnapshots.delete(mergedAccountId);
    }

    if (canonicalSnapshot) {
      this.latestSnapshots.set(canonicalAccountId, canonicalSnapshot);
    }

    return didMergeSnapshot ? canonicalSnapshot : undefined;
  }
}

/**
 * Build the canonical usage snapshot emitted after ingestion.
 * @param clientAccountId - Canonical account ID selected by the registry
 * @param payload - Ingest request payload
 * @param displayLabel - Canonical display label retained for the account
 * @returns Snapshot payload emitted to `client.usage.snapshot`
 */
function createUsageSnapshot(
  clientAccountId: string,
  payload: ClientUsageIngestRequest,
  displayLabel: string | undefined,
): ClientUsageSnapshot {
  return {
    clientAccountId,
    clientId: payload.clientId,
    observedAt: payload.observedAt,
    source: payload.source,
    displayLabel,
    usage: {
      windows: payload.usage.windows.map((window) => ({ ...window })),
    },
    metadata: payload.metadata ? { ...payload.metadata } : undefined,
  };
}

/**
 * Keep the newest snapshot when merges and fresh ingests race on one account.
 * @param existingSnapshot - Snapshot already retained for the canonical account
 * @param nextSnapshot - Snapshot built from the current ingest payload
 * @returns The snapshot with the most recent observation timestamp
 */
function selectLatestSnapshot(
  existingSnapshot: ClientUsageSnapshot | undefined,
  nextSnapshot: ClientUsageSnapshot,
): ClientUsageSnapshot {
  if (existingSnapshot && existingSnapshot.observedAt > nextSnapshot.observedAt) {
    return existingSnapshot;
  }

  return nextSnapshot;
}

/**
 * Refresh the snapshot display label when canonical account metadata improves.
 * @param snapshot - Snapshot to update
 * @param displayLabel - Canonical display label retained for the account
 * @returns Snapshot with refreshed display label, or the original snapshot
 */
function withDisplayLabel(snapshot: ClientUsageSnapshot, displayLabel: string | undefined): ClientUsageSnapshot;
function withDisplayLabel(
  snapshot: ClientUsageSnapshot | undefined,
  displayLabel: string | undefined,
): ClientUsageSnapshot | undefined;
function withDisplayLabel(
  snapshot: ClientUsageSnapshot | undefined,
  displayLabel: string | undefined,
): ClientUsageSnapshot | undefined {
  if (!snapshot || displayLabel === undefined || snapshot.displayLabel === displayLabel) {
    return snapshot;
  }

  return {
    ...snapshot,
    displayLabel,
  };
}

/**
 * Returns whether a client record is eligible for CLI-backed discovery.
 * @param client - Stored client record
 * @returns True when the client is enabled and declares a binary name
 */
function isScannableClientRecord(client: ClientRecord): client is ScannableClientRecord {
  return client.enabled && client.binaryName !== undefined;
}

/**
 * Parse a semver string into comparable numeric parts.
 *
 * Prerelease and build metadata are accepted but ignored because scan warnings
 * only need to know whether the reported major/minor/patch is below the stored
 * minimum.
 * @param version - Semver string with an optional leading `v`
 * @returns Parsed `[major, minor, patch]` tuple, or null when unparsable
 */
function parseSemver(version: string): [number, number, number] | null {
  const cleaned = version.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Returns whether the detected CLI version is lower than the required minimum.
 * @param detectedVersion - Version reported by CLI detection
 * @param minimumVersion - Minimum supported version from client storage
 * @returns True when the detected version is below the minimum
 */
function isVersionBelowMinimum(detectedVersion: string, minimumVersion: string): boolean {
  const detected = parseSemver(detectedVersion);
  const minimum = parseSemver(minimumVersion);

  if (!detected || !minimum) {
    return false;
  }

  if (detected[0] !== minimum[0]) {
    return detected[0] < minimum[0];
  }
  if (detected[1] !== minimum[1]) {
    return detected[1] < minimum[1];
  }
  return detected[2] < minimum[2];
}

/**
 * Resolve the client scan warning message for a detected CLI binary.
 * @param found - Whether the binary was detected
 * @param detectedVersion - Version reported by CLI detection, if any
 * @param minimumVersion - Minimum supported version for the client, if any
 * @returns Warning banner text, or undefined when no warning applies
 */
function resolveWarningMessage(
  found: boolean,
  detectedVersion: string | undefined,
  minimumVersion: string | undefined,
): string | undefined {
  if (
    found &&
    detectedVersion !== undefined &&
    detectedVersion !== 'unknown' &&
    minimumVersion !== undefined &&
    isVersionBelowMinimum(detectedVersion, minimumVersion)
  ) {
    return `Recommended: v${minimumVersion.replace(/^v/i, '')}+`;
  }

  return undefined;
}

/**
 * Fixture persistence for the agent-client probe harness.
 *
 * Handles writing normalized, redacted scenario fixtures and comparing
 * them against committed evidence files for verification-only mode.
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EvidenceStatus, HookContractManifest, ProviderId, RecordedHookEvent, ScenarioFixture } from './types.js';

/**
 * Canonical directory where committed fixture files live, relative to the
 * framework distribution root. Each provider owns its captures beside the
 * corresponding hook-contract fixtures.
 */
export const FIXTURES_BASE_DIR = 'clients';

/**
 * Computes the fixture file path for a given provider and scenario.
 * @param params - Path computation parameters.
 * @param params.baseDir - The absolute path to the fixtures base directory.
 * @param params.provider - The provider identifier.
 * @param params.scenarioId - The scenario identifier.
 * @returns The absolute path to the fixture JSON file.
 */
export function fixtureFilePath(params: { baseDir: string; provider: ProviderId; scenarioId: string }): string {
  const { baseDir, provider, scenarioId } = params;
  // Sanitize scenario ID for filesystem safety
  const safeId = scenarioId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(
    baseDir,
    provider,
    'src',
    'runtime',
    '__tests__',
    'fixtures',
    'hook-contracts',
    'probe',
    `${safeId}.json`,
  );
}

/**
 * Computes the provider-owned hook-contract manifest path.
 * @param params - Path computation parameters.
 * @param params.baseDir - The absolute path to the fixtures base directory.
 * @param params.provider - The provider identifier.
 * @returns The absolute path to the provider manifest.
 */
export function hookContractManifestPath(params: { baseDir: string; provider: ProviderId }): string {
  return path.join(
    params.baseDir,
    params.provider,
    'src',
    'runtime',
    '__tests__',
    'fixtures',
    'hook-contracts',
    'manifest.json',
  );
}

/**
 * Replaces one text file without exposing a partial JSON document to readers.
 * @param filePath - Destination file path.
 * @param contents - Complete UTF-8 file contents.
 */
async function writeTextAtomically(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, contents, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

/** A destination and its complete, precomputed publication bytes. */
interface PreparedPublication {
  readonly filePath: string;
  readonly contents: string;
}

/** The exact pre-publication state required to restore one destination. */
interface DestinationSnapshot {
  readonly filePath: string;
  readonly contents: string | undefined;
  /** Nearest directory that existed before publication and must not be pruned. */
  readonly cleanupBoundary: string;
}

/** Optional hooks used to exercise publication failure handling. */
export interface ProbeEvidencePublicationDependencies {
  /** Invoked immediately before each fixture or manifest publication write. */
  readonly beforePublicationWrite?: (filePath: string) => Promise<void>;
}

/**
 * Serializes one normalized fixture into its committed wire format.
 * @param fixture - Validated normalized fixture.
 * @returns Complete UTF-8 contents for the destination file.
 */
function fixtureContents(fixture: ScenarioFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** Validated staged fixtures and their events grouped for manifest aggregation. */
interface ValidatedStagedEvidence {
  readonly fixtures: readonly ScenarioFixture[];
  readonly capturedByEvent: ReadonlyMap<string, readonly RecordedHookEvent[]>;
}

/**
 * Loads and validates every staged fixture before publication can begin.
 * @param params - Staging paths and source contract used for validation.
 * @returns Validated fixtures plus captured events grouped by native event name.
 */
async function readValidatedStagedEvidence(params: {
  stagedBaseDir: string;
  provider: ProviderId;
  fixtures: readonly ScenarioFixture[];
  declaredEvents: HookContractManifest['events'];
}): Promise<ValidatedStagedEvidence> {
  const stagedFixtures = await Promise.all(
    params.fixtures.map(async (fixture) => {
      const stagedPath = fixtureFilePath({
        baseDir: params.stagedBaseDir,
        provider: fixture.provider,
        scenarioId: fixture.scenarioId,
      });
      const stagedFixture = await readFixture(stagedPath);
      if (!stagedFixture) throw new Error(`Missing staged fixture: ${stagedPath}`);
      if (stagedFixture.scenarioId !== fixture.scenarioId)
        throw new Error(
          `Staged fixture scenario mismatch: expected ${fixture.scenarioId}, got ${stagedFixture.scenarioId}`,
        );
      return stagedFixture;
    }),
  );
  const capturedByEvent = new Map<string, RecordedHookEvent[]>();
  for (const fixture of stagedFixtures) {
    if (fixture.provider !== params.provider)
      throw new Error(`Cannot publish ${fixture.provider} fixture into ${params.provider} evidence`);
    for (const event of fixture.events) {
      if (!params.declaredEvents[event.eventName])
        throw new Error(`Probe fixture references undeclared ${params.provider} event "${event.eventName}"`);
      const captured = capturedByEvent.get(event.eventName) ?? [];
      captured.push(event);
      capturedByEvent.set(event.eventName, captured);
    }
  }
  return { fixtures: stagedFixtures, capturedByEvent };
}

/**
 * Finds the nearest existing directory above a destination.
 * @param directory - Directory that will contain a destination file.
 * @returns Existing ancestor directory that rollback must retain.
 */
async function nearestExistingDirectory(directory: string): Promise<string> {
  let candidate = directory;
  while (true) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isDirectory()) throw new Error(`Publication ancestor is not a directory: ${candidate}`);
      return candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error(`Cannot find an existing publication ancestor for: ${directory}`);
      candidate = parent;
    }
  }
}

/**
 * Captures a destination's exact bytes before any publication writes begin.
 * @param filePath - Destination whose state may need restoring.
 * @returns Complete pre-publication state.
 */
async function snapshotDestination(filePath: string): Promise<DestinationSnapshot> {
  let contents: string | undefined;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    filePath,
    contents,
    cleanupBoundary: await nearestExistingDirectory(path.dirname(filePath)),
  };
}

/**
 * Removes only directories created for a newly published destination.
 * @param startDirectory - First directory to consider removing.
 * @param cleanupBoundary - Pre-existing ancestor directory that must remain.
 */
async function removeNewEmptyDirectories(startDirectory: string, cleanupBoundary: string): Promise<void> {
  let candidate = startDirectory;
  while (candidate !== cleanupBoundary) {
    try {
      await fs.rmdir(candidate);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY') return;
      throw error;
    }
    candidate = path.dirname(candidate);
  }
}

/**
 * Restores one destination to its pre-publication state.
 * @param snapshot - Complete state captured before publication.
 */
async function restoreDestination(snapshot: DestinationSnapshot): Promise<void> {
  if (snapshot.contents !== undefined) {
    await writeTextAtomically(snapshot.filePath, snapshot.contents);
    return;
  }
  await fs.rm(snapshot.filePath, { force: true });
  await removeNewEmptyDirectories(path.dirname(snapshot.filePath), snapshot.cleanupBoundary);
}

/**
 * Writes a scenario fixture to disk.
 *
 * Creates the provider subdirectory if it does not exist.
 * @param params - Write parameters.
 * @param params.baseDir - The absolute path to the fixtures base directory.
 * @param params.fixture - The normalized fixture to persist.
 * @returns The absolute path to the written file.
 */
export async function writeFixture(params: { baseDir: string; fixture: ScenarioFixture }): Promise<string> {
  const filePath = fixtureFilePath({
    baseDir: params.baseDir,
    provider: params.fixture.provider,
    scenarioId: params.fixture.scenarioId,
  });
  await writeTextAtomically(filePath, fixtureContents(params.fixture));
  return filePath;
}

/**
 * Publishes a complete successful probe as one manifest-last transaction.
 * @param params - Published provider evidence and its committed destination.
 * @param params.baseDir - The absolute path to provider fixture storage.
 * @param params.stagedBaseDir - Disposable staging directory populated by the complete probe.
 * @param params.provider - Provider whose evidence is being published.
 * @param params.fixtures - Every normalized fixture from the complete probe.
 * @param params.capturedAt - ISO timestamp for the complete probe transaction.
 */
export async function publishProbeEvidence(params: {
  baseDir: string;
  stagedBaseDir: string;
  provider: ProviderId;
  fixtures: readonly ScenarioFixture[];
  capturedAt: string;
  dependencies?: ProbeEvidencePublicationDependencies;
}): Promise<void> {
  const manifestPath = hookContractManifestPath({ baseDir: params.baseDir, provider: params.provider });
  const manifest = await readHookContractManifest(manifestPath, params.provider);
  const eventNames = Object.keys(manifest.events);
  const stagedEvidence = await readValidatedStagedEvidence({
    stagedBaseDir: params.stagedBaseDir,
    provider: params.provider,
    fixtures: params.fixtures,
    declaredEvents: manifest.events,
  });
  const events = Object.fromEntries(
    eventNames.map((eventName) => {
      const captured = stagedEvidence.capturedByEvent.get(eventName) ?? [];
      const observedEvidenceStatus: EvidenceStatus =
        captured.length === 0
          ? 'unobserved'
          : captured.some((event) => event.observedStatus === 'supported')
            ? 'supported'
            : 'observer-only';
      return [
        eventName,
        {
          ...manifest.events[eventName],
          observedEvidenceStatus,
          hookFired: captured.length > 0,
        },
      ];
    }),
  );
  const publishedManifest: HookContractManifest = {
    ...manifest,
    liveProbe: { status: 'captured', capturedAt: params.capturedAt },
    events,
  };
  const fixturePublications = stagedEvidence.fixtures.map((fixture) => ({
    filePath: fixtureFilePath({
      baseDir: params.baseDir,
      provider: fixture.provider,
      scenarioId: fixture.scenarioId,
    }),
    contents: fixtureContents(fixture),
  }));
  const uniqueFixturePaths = new Set(fixturePublications.map(({ filePath }) => filePath));
  if (uniqueFixturePaths.size !== fixturePublications.length)
    throw new Error(`Probe evidence contains duplicate ${params.provider} scenario destinations`);

  // All bytes and every reversible destination are prepared before the first write.
  const publications: readonly PreparedPublication[] = [
    ...fixturePublications,
    { filePath: manifestPath, contents: `${JSON.stringify(publishedManifest, null, 2)}\n` },
  ];
  const snapshots = await Promise.all(publications.map(({ filePath }) => snapshotDestination(filePath)));
  try {
    for (const publication of publications) {
      await params.dependencies?.beforePublicationWrite?.(publication.filePath);
      await writeTextAtomically(publication.filePath, publication.contents);
    }
  } catch (error: unknown) {
    const rollback = await Promise.allSettled(snapshots.map((snapshot) => restoreDestination(snapshot)));
    const rollbackErrors = rollback.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (rollbackErrors.length > 0)
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Probe evidence publication failed and rollback was incomplete',
      );
    throw error;
  }
}

/**
 * Reads and minimally validates the source-owned hook-contract manifest.
 * @param manifestPath - Absolute provider manifest path.
 * @param provider - Provider expected by the destination path.
 * @returns Parsed manifest retaining all source-owned fields.
 */
async function readHookContractManifest(manifestPath: string, provider: ProviderId): Promise<HookContractManifest> {
  const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`Invalid hook-contract manifest: ${manifestPath}`);
  const manifest = parsed as Partial<HookContractManifest>;
  if (
    manifest.clientId !== provider ||
    !manifest.events ||
    typeof manifest.events !== 'object' ||
    Array.isArray(manifest.events)
  )
    throw new Error(`Invalid ${provider} hook-contract manifest: ${manifestPath}`);
  return manifest as HookContractManifest;
}

/**
 * Reads a committed fixture file.
 * @param filePath - Absolute path to the fixture file.
 * @returns The parsed fixture, or `undefined` if the file does not exist.
 */
export async function readFixture(filePath: string): Promise<ScenarioFixture | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as ScenarioFixture;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Compares one normalized event projection without inspecting raw hook input.
 * @param recorded - Fresh event projection.
 * @param committed - Committed event projection.
 * @param index - Event ordinal within its scenario.
 * @returns All changed stable fields.
 */
function compareEvent(recorded: RecordedHookEvent, committed: RecordedHookEvent, index: number): string[] {
  const prefix = `Event[${String(index)}]`;
  const fields: ReadonlyArray<[string, unknown, unknown]> = [
    ['name', recorded.eventName, committed.eventName],
    ['mode', recorded.mode, committed.mode],
    ['candidate expected status', recorded.candidateExpectedStatus, committed.candidateExpectedStatus],
    ['observed status', recorded.observedStatus, committed.observedStatus],
    ['source expected effects', recorded.sourceExpectedEffects, committed.sourceExpectedEffects],
    ['observed effects', recorded.observedEffects, committed.observedEffects],
    ['blocking capability', recorded.blockingCapable, committed.blockingCapable],
    ['managed command', recorded.managedCommand, committed.managedCommand],
    ['responseCapabilities', recorded.responseCapabilities, committed.responseCapabilities],
    ['frameworkSubject', recorded.frameworkSubject, committed.frameworkSubject],
    ['payload keys', recorded.payloadKeys, committed.payloadKeys],
    ['sentinel injection', recorded.sentinelInjected, committed.sentinelInjected],
  ];
  return fields
    .filter(([, actual, expected]) => JSON.stringify(actual) !== JSON.stringify(expected))
    .map(([name]) => `${prefix} ${name} changed`);
}

/**
 * Compares a freshly recorded fixture against a committed one.
 *
 * Returns a list of human-readable differences. An empty list means the
 * fixtures are equivalent.
 * @param params - Comparison parameters.
 * @param params.recorded - The fixture just produced by the probe.
 * @param params.committed - The fixture from the committed evidence file.
 * @returns A list of difference descriptions.
 */
export function compareFixtures(params: { recorded: ScenarioFixture; committed: ScenarioFixture }): readonly string[] {
  const { recorded, committed } = params;
  const diffs: string[] = [];

  if (recorded.provider !== committed.provider) {
    diffs.push(`Provider mismatch: recorded "${recorded.provider}" vs committed "${committed.provider}"`);
  }

  if (recorded.schemaVersion !== committed.schemaVersion) {
    diffs.push(
      `Schema version changed: recorded ${String(recorded.schemaVersion)} vs committed ${String(committed.schemaVersion)}`,
    );
  }

  if (recorded.cliVersion !== committed.cliVersion) {
    diffs.push(`CLI version changed: recorded "${recorded.cliVersion}" vs committed "${committed.cliVersion}"`);
  }

  if (recorded.events.length !== committed.events.length) {
    diffs.push(
      `Event count changed: recorded ${String(recorded.events.length)} vs committed ${String(committed.events.length)}`,
    );
  }

  const minLen = Math.min(recorded.events.length, committed.events.length);
  for (let i = 0; i < minLen; i++) {
    const rec = recorded.events[i];
    const com = committed.events[i];
    if (!rec || !com) continue;

    diffs.push(...compareEvent(rec, com, i));
  }

  if (recorded.oracle !== committed.oracle) {
    diffs.push(`Oracle changed: recorded "${recorded.oracle}" vs committed "${committed.oracle}"`);
  }

  if (recorded.exitCode !== committed.exitCode) {
    diffs.push(`Exit code changed: recorded ${String(recorded.exitCode)} vs committed ${String(committed.exitCode)}`);
  }

  if (recorded.oraclePassed !== committed.oraclePassed) {
    diffs.push(
      `Oracle result changed: recorded ${String(recorded.oraclePassed)} vs committed ${String(committed.oraclePassed)}`,
    );
  }

  return diffs;
}

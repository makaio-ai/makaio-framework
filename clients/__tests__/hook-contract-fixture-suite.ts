/**
 * Shared deterministic hook-contract evidence tests.
 *
 * Provider manifests deliberately keep source-backed candidate evidence and
 * paid live-probe observations separate. Ordinary tests validate committed
 * source evidence and fixture examples without implying that a native CLI was
 * executed.
 * @packageDocumentation
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveHookEventTransportMode } from '@makaio/contracts';
import type { ClientDefinition } from '@makaio/contracts';
import type {
  EvidenceStatus,
  RecordedHookEvent,
  ScenarioFixture,
  ScenarioManifest,
} from '../../scripts/lib/agent-clients/types.js';
import { describe, expect, it } from 'vitest';

const VALID_EVIDENCE_STATUSES = ['supported', 'observer-only', 'unobserved'] as const;
const VALID_ORACLES = [
  'capture-only',
  'final-response-must-contain-marker',
  'sentinel-must-block-before-model',
  'sentinel-must-allow-tool',
  'sentinel-must-block-tool',
  'sentinel-must-rewrite-tool',
  'native-must-deny-unapproved-tool',
  'unobserved',
] as const;

interface ManifestEventEntry {
  readonly candidateEvidenceStatus: EvidenceStatus;
  readonly observedEvidenceStatus: EvidenceStatus | null;
  readonly hookFired: boolean | null;
  readonly expectedStdoutConsumed: boolean;
  readonly expectedBlockingCapable: boolean;
  readonly managedCommand: string;
  readonly responseCapabilities: readonly string[];
  readonly inputFixture: string | null;
  readonly outputFixture: string | null;
}

interface FixtureManifest {
  readonly version: string;
  readonly clientId: string;
  readonly cliVersion: string;
  readonly sourceEvidence: {
    readonly kind: 'official-documentation' | 'pinned-source';
    readonly reference: string;
    readonly verifiedAt: string;
  };
  readonly liveProbe: {
    readonly status: 'pending' | 'captured';
    readonly capturedAt: string | null;
  };
  readonly events: Record<string, ManifestEventEntry>;
}

/**
 * Parses a JSON file.
 * @param filePath - Absolute JSON file path.
 * @returns Parsed JSON value.
 */
function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/** Parameters for the shared fixture suite. */
export interface HookContractFixtureSuiteParams {
  /** Provider identifier. */
  readonly clientId: string;
  /** Static client contract validated by the evidence. */
  readonly clientDefinition: ClientDefinition;
  /** Absolute provider fixture directory. */
  readonly fixturesDir: string;
  /** Provider capabilities that can synchronously prevent the native action. */
  readonly blockingCapabilities: readonly string[];
  /** Complete source-derived scenario set that a captured live probe must publish. */
  readonly scenarioManifest: ScenarioManifest;
  /** Optional provider-specific assertions over parsed source fixtures. */
  readonly validateEventFixtures?: (eventName: string, input: unknown, output: unknown) => void;
}

/**
 * Returns whether a parsed JSON value is a record.
 * @param value - Parsed JSON value.
 * @returns Whether the value has string keys.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns whether a parsed JSON value has the normalized scenario-fixture shape.
 * @param value - Parsed JSON value.
 * @returns Whether the value is a probe scenario fixture.
 */
export function isScenarioFixture(value: unknown): value is ScenarioFixture {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 3 ||
    (value.provider !== 'claude-code' && value.provider !== 'codex') ||
    typeof value.cliVersion !== 'string' ||
    typeof value.scenarioId !== 'string' ||
    !Array.isArray(value.events) ||
    !(VALID_ORACLES as readonly string[]).includes(value.oracle as string) ||
    typeof value.oraclePassed !== 'boolean' ||
    !(typeof value.exitCode === 'number' || value.exitCode === null)
  ) {
    return false;
  }
  return value.events.every(isRecordedHookEvent);
}

/**
 * Returns whether a parsed JSON value has the full normalized hook-event shape.
 * @param value - Parsed JSON value.
 * @returns Whether the value is a recorded hook event.
 */
function isRecordedHookEvent(value: unknown): value is RecordedHookEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.eventName === 'string' &&
    (value.frameworkSubject === undefined || typeof value.frameworkSubject === 'string') &&
    Array.isArray(value.responseCapabilities) &&
    value.responseCapabilities.every((capability) => typeof capability === 'string') &&
    (value.mode === 'event' || value.mode === 'request') &&
    (VALID_EVIDENCE_STATUSES as readonly string[]).includes(value.candidateExpectedStatus as string) &&
    (VALID_EVIDENCE_STATUSES as readonly string[]).includes(value.observedStatus as string) &&
    Array.isArray(value.sourceExpectedEffects) &&
    value.sourceExpectedEffects.every((effect) => typeof effect === 'string') &&
    Array.isArray(value.observedEffects) &&
    value.observedEffects.every((effect) => typeof effect === 'string') &&
    typeof value.blockingCapable === 'boolean' &&
    typeof value.managedCommand === 'string' &&
    value.managedCommand.length > 0 &&
    Array.isArray(value.payloadKeys) &&
    value.payloadKeys.every((key) => typeof key === 'string') &&
    typeof value.sentinelInjected === 'boolean'
  );
}

/**
 * Registers deterministic evidence and fixture consistency tests.
 * @param params - Provider definition and fixture location.
 */
export function runHookContractFixtureSuite(params: HookContractFixtureSuiteParams): void {
  const { blockingCapabilities, clientId, clientDefinition, fixturesDir, scenarioManifest, validateEventFixtures } =
    params;
  const manifest = readJson(resolve(fixturesDir, 'manifest.json')) as FixtureManifest;

  describe(`${clientId} hook contract fixtures`, () => {
    describe('manifest structure', () => {
      it('uses the source/live evidence schema', () => {
        expect(manifest.version).toBe('0.2.0');
        expect(manifest.clientId).toBe(clientId);
        expect(manifest.cliVersion).toBe(clientDefinition.managedInstall?.version);
      });

      it('identifies non-live evidence precisely', () => {
        expect(['official-documentation', 'pinned-source']).toContain(manifest.sourceEvidence.kind);
        expect(manifest.sourceEvidence.reference).toMatch(/^https:\/\//);
        expect(Number.isNaN(Date.parse(manifest.sourceEvidence.verifiedAt))).toBe(false);
      });

      it('records live-probe state without placeholder timestamps', () => {
        expect(['pending', 'captured']).toContain(manifest.liveProbe.status);
        if (manifest.liveProbe.status === 'pending') {
          expect(manifest.liveProbe.capturedAt).toBeNull();
        } else {
          expect(manifest.liveProbe.capturedAt).not.toBeNull();
          expect(Number.isNaN(Date.parse(manifest.liveProbe.capturedAt!))).toBe(false);
        }
      });

      it('has a non-empty events map', () => {
        expect(Object.keys(manifest.events).length).toBeGreaterThan(0);
      });
    });

    describe('definition-manifest sync', () => {
      const declaredEventNames = clientDefinition.runtimeCapabilities.hookEvents.map((event) => event.name);
      const manifestEventNames = Object.keys(manifest.events);

      it('contains exactly the declared event names', () => {
        expect(manifestEventNames.sort()).toEqual([...declaredEventNames].sort());
      });

      for (const hookEvent of clientDefinition.runtimeCapabilities.hookEvents) {
        const entry = manifest.events[hookEvent.name];
        if (!entry) continue;
        const mode = deriveHookEventTransportMode(hookEvent);

        it(`${hookEvent.name}: matches declared capabilities and transport`, () => {
          expect(entry.responseCapabilities).toEqual(hookEvent.responseCapabilities ?? []);
          expect(new Set(entry.responseCapabilities).size).toBe(entry.responseCapabilities.length);
          expect(typeof entry.expectedStdoutConsumed).toBe('boolean');
          expect(typeof entry.expectedBlockingCapable).toBe('boolean');
          expect(entry.expectedStdoutConsumed).toBe(mode === 'request');
          expect(entry.expectedBlockingCapable).toBe(
            entry.responseCapabilities.some((capability) => blockingCapabilities.includes(capability)),
          );
          expect(entry.managedCommand).toBe(`hook ${mode === 'request' ? 'handle' : 'received'} ${clientId}`);
        });

        it(`${hookEvent.name}: source status is capability-honest`, () => {
          expect(VALID_EVIDENCE_STATUSES as readonly string[]).toContain(entry.candidateEvidenceStatus);
          if (entry.candidateEvidenceStatus === 'supported') {
            expect(entry.responseCapabilities.length).toBeGreaterThan(0);
            expect(mode).toBe('request');
          } else {
            expect(entry.responseCapabilities).toEqual([]);
            expect(entry.expectedBlockingCapable).toBe(false);
            expect(mode).toBe('event');
          }
        });
      }
    });

    describe('live observation honesty', () => {
      for (const [eventName, entry] of Object.entries(manifest.events)) {
        it(`${eventName}: observation fields match the live-probe state`, () => {
          if (manifest.liveProbe.status === 'pending') {
            expect(entry.observedEvidenceStatus).toBeNull();
            expect(entry.hookFired).toBeNull();
          } else {
            expect(VALID_EVIDENCE_STATUSES as readonly (string | null)[]).toContain(entry.observedEvidenceStatus);
            expect(typeof entry.hookFired).toBe('boolean');
            if (entry.observedEvidenceStatus === 'unobserved') expect(entry.hookFired).toBe(false);
            else expect(entry.hookFired).toBe(true);
          }
        });
      }
    });

    describe('committed live-probe evidence', () => {
      const probeDir = resolve(fixturesDir, 'probe');
      const probeEntries = existsSync(probeDir) ? readdirSync(probeDir).sort() : [];
      const probeFiles = probeEntries.filter((name) => name.endsWith('.json')).sort();
      const probeFixtures = probeFiles.map((fileName) => {
        const parsed = readJson(resolve(probeDir, fileName));
        expect(isScenarioFixture(parsed), `Invalid probe fixture schema: ${fileName}`).toBe(true);
        if (!isScenarioFixture(parsed)) throw new TypeError(`Invalid probe fixture schema: ${fileName}`);
        return parsed;
      });

      it('uses the source-derived scenario manifest for this provider and pinned CLI', () => {
        expect(scenarioManifest.provider).toBe(clientId);
        expect(scenarioManifest.pinnedVersion).toBe(clientDefinition.managedInstall?.version);
      });

      it('is absent until a pending live probe is captured', () => {
        if (manifest.liveProbe.status === 'pending') expect(probeEntries).toEqual([]);
      });

      if (manifest.liveProbe.status === 'captured') {
        it('contains exactly one passing, schema-valid fixture for every expected scenario', () => {
          expect(probeEntries).toEqual(probeFiles);
          const expectedScenarioIds = scenarioManifest.scenarios.map((scenario) => scenario.id).sort();
          const actualScenarioIds = probeFixtures.map((fixture) => fixture.scenarioId).sort();
          expect(new Set(actualScenarioIds).size).toBe(actualScenarioIds.length);
          expect(actualScenarioIds).toEqual(expectedScenarioIds);
          for (const fixture of probeFixtures) {
            expect(fixture.schemaVersion).toBe(3);
            expect(fixture.provider).toBe(clientId);
            expect(fixture.cliVersion).toBe(scenarioManifest.pinnedVersion);
            expect(fixture.oraclePassed).toBe(true);
          }
        });

        it('proves every source-expected effect through an oracle-passing fixture', () => {
          const requiredEffects = new Set<string>();
          for (const scenario of scenarioManifest.scenarios) {
            const event = scenario.expectedEvents[0];
            if (!event) continue;
            for (const effect of scenario.sourceExpectedEffects) requiredEffects.add(`${event.eventName}:${effect}`);
          }
          const observedEffects = new Set<string>();
          for (const fixture of probeFixtures) {
            for (const event of fixture.events) {
              for (const effect of event.observedEffects) observedEffects.add(`${event.eventName}:${effect}`);
            }
          }
          expect([...requiredEffects].filter((effect) => !observedEffects.has(effect)).sort()).toEqual([]);
        });

        it('preserves every scenario-owned event contract in its matching capture', () => {
          const scenariosById = new Map(scenarioManifest.scenarios.map((scenario) => [scenario.id, scenario]));
          for (const fixture of probeFixtures) {
            const scenario = scenariosById.get(fixture.scenarioId);
            expect(scenario, `Unexpected fixture scenario: ${fixture.scenarioId}`).toBeDefined();
            if (!scenario) continue;
            expect(fixture.oracle).toBe(scenario.oracle);
            for (const event of fixture.events) {
              const expectedEvent = scenario.expectedEvents.find(
                (candidate) => candidate.eventName === event.eventName,
              );
              expect(
                expectedEvent,
                `${fixture.scenarioId}: unexpected captured event ${event.eventName}`,
              ).toBeDefined();
              if (!expectedEvent) continue;
              expect(event.frameworkSubject).toBe(expectedEvent.frameworkSubject);
              expect(event.responseCapabilities).toEqual(expectedEvent.responseCapabilities);
              expect(event.mode).toBe(expectedEvent.mode);
              expect(event.candidateExpectedStatus).toBe(scenario.candidateExpectedStatus);
              expect(event.sourceExpectedEffects).toEqual(scenario.sourceExpectedEffects);
              expect(event.blockingCapable).toBe(scenario.blockingCapable);
              expect(event.managedCommand).toBe(scenario.expectedManagedCommand);
              expect(event.sentinelInjected).toBe(scenario.sentinelOutput !== undefined);
              expect(event.observedEffects.every((effect) => scenario.sourceExpectedEffects.includes(effect))).toBe(
                true,
              );
              expect([...event.payloadKeys].sort()).toEqual(event.payloadKeys);
              expect(new Set(event.payloadKeys).size).toBe(event.payloadKeys.length);
            }
          }
        });

        it('recomputes each event observation summary from the committed fixtures', () => {
          for (const [eventName, entry] of Object.entries(manifest.events)) {
            const captured = probeFixtures.flatMap((fixture) =>
              fixture.events.filter((event) => event.eventName === eventName),
            );
            const observedEvidenceStatus: EvidenceStatus =
              captured.length === 0
                ? 'unobserved'
                : captured.some((event) => event.observedStatus === 'supported')
                  ? 'supported'
                  : 'observer-only';
            expect(entry.hookFired, `${eventName}: stale hookFired aggregate`).toBe(captured.length > 0);
            expect(entry.observedEvidenceStatus, `${eventName}: stale observed evidence aggregate`).toBe(
              observedEvidenceStatus,
            );
          }
        });
      }
    });

    describe('fixture references', () => {
      const referencedFiles = new Set<string>();

      for (const [eventName, entry] of Object.entries(manifest.events)) {
        it(`${eventName}: fixture references are paired`, () => {
          expect(entry.inputFixture === null).toBe(entry.outputFixture === null);
          if (entry.candidateEvidenceStatus === 'supported') {
            expect(entry.inputFixture).not.toBeNull();
            expect(entry.outputFixture).not.toBeNull();
          }
        });

        for (const [kind, fixture] of [
          ['input', entry.inputFixture],
          ['output', entry.outputFixture],
        ] as const) {
          if (fixture === null) continue;
          referencedFiles.add(fixture);
          it(`${eventName}: ${kind} fixture exists and is valid JSON`, () => {
            const filePath = resolve(fixturesDir, fixture);
            expect(existsSync(filePath), `${kind} fixture file not found: ${fixture}`).toBe(true);
            expect(() => readJson(filePath)).not.toThrow();
          });
        }

        if (entry.inputFixture !== null && entry.outputFixture !== null && validateEventFixtures) {
          it(`${eventName}: provider-specific source schema fields are preserved`, () => {
            validateEventFixtures(
              eventName,
              readJson(resolve(fixturesDir, entry.inputFixture!)),
              readJson(resolve(fixturesDir, entry.outputFixture!)),
            );
          });
        }
      }

      it('has no orphan JSON fixtures', () => {
        const fixtureFiles = readdirSync(fixturesDir).filter(
          (name) => name.endsWith('.json') && name !== 'manifest.json',
        );
        expect(fixtureFiles.sort()).toEqual([...referencedFiles].sort());
      });
    });
  });
}

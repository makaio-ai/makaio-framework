/**
 * Pure wiring handler functions for the Claude Code client service.
 *
 * Extracted from {@link ClaudeCodeClientService} to keep that file within the
 * 400-line source budget. Each function corresponds to one `wiring.*` subject
 * handler registered by the service.
 *
 * All three handlers share a common {@link WiringHandlerDeps} injection point so
 * they can be unit-tested independently of the service's bus infrastructure.
 * @packageDocumentation
 */

import {
  assertAbsoluteProjectDir,
  type ClientWiringApplyResponse,
  type ClientWiringListResponse,
  type ClientWiringRemoveResponse,
} from '@makaio/subsystem-client';

import { ClaudeCodeClientSettings } from './client-settings.js';
import type {
  ClaudeCodeWiringApplyRequest,
  ClaudeCodeWiringListRequest,
  ClaudeCodeWiringRemoveRequest,
} from '../schemas/wiring.js';
import { applyClaudeCodeWiring, buildClaudeCodeWiringList, removeClaudeCodeWiring } from './wiring.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Minimal execution-context slice consumed by wiring handler functions.
 *
 * Mirrors the private `ResolvedExecutionCtx` type in
 * {@link ClaudeCodeClientService} and is intentionally kept narrow —
 * wiring handlers only need the config directory and binary version.
 */
export type WiringExecutionCtx = { configDir: string | undefined; version: string | null | undefined } | undefined;

/**
 * Dependencies injected into wiring handler functions by the owning service.
 *
 * Using an explicit dependency object (rather than `this` references) keeps the
 * handlers pure and independently testable.
 */
export interface WiringHandlerDeps {
  /**
   * Resolve the binary execution context fresh, bypassing the service cache.
   *
   * Wiring handlers call this on every request so that global binaries found on
   * `PATH` — which can update without triggering `client.version.changed` — are
   * reflected immediately.  The overhead is one `client.resolveBinary` bus
   * request per wire command, which is acceptable because wiring calls are rare.
   */
  resolveContextFresh: () => Promise<WiringExecutionCtx>;
  /**
   * Create a {@link ClaudeCodeClientSettings} instance bound to the resolved
   * config directory.
   */
  createSettings: (projectDir?: string) => Promise<ClaudeCodeClientSettings>;
}

// ---------------------------------------------------------------------------
// Handler functions
// ---------------------------------------------------------------------------

/**
 * Handle a `wiring.list` request.
 *
 * Resolves the execution context fresh on every call so that a global binary
 * update is visible without waiting for `client.version.changed`. Events whose
 * `minimumVersion` exceeds the resolved binary version are omitted from the
 * result.
 * @param payload - Validated `wiring.list` request payload.
 * @param deps - Service-provided handler dependencies.
 * @returns Wiring entries with their current installation status.
 */
export async function handleWiringList(
  payload: ClaudeCodeWiringListRequest,
  deps: WiringHandlerDeps,
): Promise<ClientWiringListResponse> {
  assertAbsoluteProjectDir(payload.projectDir);
  const execCtx = await deps.resolveContextFresh();
  const settings = new ClaudeCodeClientSettings({
    projectDir: payload.projectDir,
    configDir: execCtx?.configDir,
  });
  return buildClaudeCodeWiringList(settings, payload.makaioCommand, payload.envPairs, execCtx?.version);
}

/**
 * Handle a `wiring.apply` request.
 *
 * Resolves the execution context fresh on every call. An explicit `binaryVersion`
 * in the payload takes precedence over the resolved version so that callers that
 * already hold the binary execution context (e.g. managed-session connectors) can
 * supply the exact version being launched without an additional bus round-trip.
 *
 * Events whose `minimumVersion` exceeds the effective binary version are skipped;
 * any Makaio-managed hooks for those events that are already present in the target
 * scope are removed.
 * @param payload - Validated `wiring.apply` request payload.
 * @param deps - Service-provided handler dependencies.
 * @returns Counts of wiring entries applied and skipped.
 */
export async function handleWiringApply(
  payload: ClaudeCodeWiringApplyRequest,
  deps: WiringHandlerDeps,
): Promise<ClientWiringApplyResponse> {
  assertAbsoluteProjectDir(payload.projectDir);
  if ((payload.scope === 'project' || payload.scope === 'local') && !payload.projectDir) {
    throw new Error(`projectDir is required when scope is '${payload.scope}'`);
  }
  // A caller that already holds the launched execution context (session
  // configDir plus binaryVersion) must not depend on the resolver's current
  // state: the active selection may have changed since adapter preparation,
  // and a failing resolve would abort a session whose binary is fine. Only
  // resolve what the payload leaves open.
  const needsResolution = payload.configDir === undefined || payload.binaryVersion === undefined;
  const execCtx = needsResolution ? await deps.resolveContextFresh() : undefined;
  const configDir = payload.configDir ?? execCtx?.configDir;
  const settings = new ClaudeCodeClientSettings({ projectDir: payload.projectDir, configDir });
  const binaryVersion = payload.binaryVersion !== undefined ? payload.binaryVersion : execCtx?.version;
  return applyClaudeCodeWiring(settings, payload.scope, payload.makaioCommand, payload.envPairs, {
    skipDangerousModePermissionPrompt: payload.skipDangerousModePermissionPrompt,
    binaryVersion,
  });
}

/**
 * Handle a `wiring.remove` request.
 *
 * Removes all Makaio-managed wiring entries from the target scope for every
 * declared event, regardless of binary version.  This ensures a clean uninstall
 * even after a binary downgrade.
 * @param payload - Validated `wiring.remove` request payload.
 * @param deps - Service-provided handler dependencies.
 * @returns Number of wiring entries removed.
 */
export async function handleWiringRemove(
  payload: ClaudeCodeWiringRemoveRequest,
  deps: WiringHandlerDeps,
): Promise<ClientWiringRemoveResponse> {
  assertAbsoluteProjectDir(payload.projectDir);
  if ((payload.scope === 'project' || payload.scope === 'local') && !payload.projectDir) {
    throw new Error(`projectDir is required when scope is '${payload.scope}'`);
  }
  return removeClaudeCodeWiring(await deps.createSettings(payload.projectDir), payload.scope);
}

/**
 * Tool capability taxonomy for the Makaio harness.
 *
 * Defines the canonical, platform-owned set of capability identifiers that
 * tools declare at registration time. Capability data drives policy decisions
 * (e.g. ToolApprovalService) and UI presentation without coupling adapters to
 * one another.
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * Canonical capability taxonomy. Platform-owned and adapter-agnostic.
 * Tools map to one or more capabilities at declaration time.
 */
export const ToolCapability = {
  /** Read the contents of a file from the local filesystem. */
  FILE_READ: 'file.read',
  /** Write or create a file on the local filesystem. */
  FILE_WRITE: 'file.write',
  /** Delete a file or directory from the local filesystem. */
  FILE_DELETE: 'file.delete',
  /** Search within file contents (grep-style). */
  SEARCH_CONTENT: 'search.content',
  /** Search for files by name or pattern (glob/find-style). */
  SEARCH_FILES: 'search.files',
  /** Perform a web or internet search. */
  SEARCH_WEB: 'search.web',
  /** Execute arbitrary shell commands. */
  SHELL_EXECUTE: 'shell.execute',
  /** Make HTTP or other network requests. */
  NETWORK_REQUEST: 'network.request',
  /** Start, stop, or otherwise manage OS processes. */
  PROCESS_MANAGE: 'process.manage',
} as const;

/** Union of all capability string literals. */
export type ToolCapability = (typeof ToolCapability)[keyof typeof ToolCapability];

/**
 * Semantic meta-tags derived from a tool's capability set.
 *
 * - `'read-only'`  — the tool only reads state; it never mutates anything.
 * - `'destructive'` — the tool can modify or destroy data/processes.
 */
export type ToolMetaTag = 'read-only' | 'destructive';

/**
 * Capabilities that are strictly read-only — they observe but never mutate
 * files, processes, or external state.
 *
 * Note: {@link ToolCapability.NETWORK_REQUEST} is intentionally absent from both sets.
 * Network calls can be read-only (GET) or mutating (POST/DELETE/webhooks).
 * Tools with only NETWORK_REQUEST receive no meta-tag and are treated as neutral.
 */
export const READ_ONLY_CAPABILITIES: ReadonlySet<ToolCapability> = new Set([
  ToolCapability.FILE_READ,
  ToolCapability.SEARCH_CONTENT,
  ToolCapability.SEARCH_FILES,
  ToolCapability.SEARCH_WEB,
]);

/**
 * Capabilities that can mutate or destroy files, data, or OS-level resources.
 */
export const DESTRUCTIVE_CAPABILITIES: ReadonlySet<ToolCapability> = new Set([
  ToolCapability.FILE_WRITE,
  ToolCapability.FILE_DELETE,
  ToolCapability.SHELL_EXECUTE,
  ToolCapability.PROCESS_MANAGE,
]);

/**
 * Zod schema for runtime validation of a {@link ToolCapability} string.
 *
 * Derived directly from {@link ToolCapability} values to prevent drift when
 * new capabilities are added — no manual list to maintain.
 *
 * Use this wherever capability values arrive from external sources (bus
 * payloads, config files, API responses) and must be validated before use.
 */
const capabilityValues = Object.values(ToolCapability) as [ToolCapability, ...ToolCapability[]];
export const ToolCapabilitySchema = z.enum(capabilityValues);

/**
 * Derives semantic meta-tags from a tool's declared capabilities.
 *
 * - Returns `'read-only'` when **all** capabilities are in
 * the read-only capability set (the tool observes only).
 * - Returns `'destructive'` when **any** capability is in
 * the destructive capability set (the tool can mutate/destroy).
 * - No tags may be returned (e.g. a tool with only `NETWORK_REQUEST` receives
 * neither {@link ToolMetaTag}).
 * - `'read-only'` and `'destructive'` cannot both be returned in the current
 * taxonomy because the read-only and destructive capability sets are disjoint.
 * @param capabilities - The capability values declared by the tool.
 * @returns An array of {@link ToolMetaTag} values that apply to the tool.
 */
export function computeMetaTags(capabilities: readonly ToolCapability[]): ToolMetaTag[] {
  const tags: ToolMetaTag[] = [];

  if (capabilities.length > 0 && capabilities.every((cap) => READ_ONLY_CAPABILITIES.has(cap))) {
    tags.push('read-only');
  }

  if (capabilities.some((cap) => DESTRUCTIVE_CAPABILITIES.has(cap))) {
    tags.push('destructive');
  }

  return tags;
}

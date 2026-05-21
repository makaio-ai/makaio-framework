/**
 * Tool capability picker data contracts.
 *
 * Types used by the CapabilityPicker UI component for three-state
 * capability selection and raw tool override management.
 * @packageDocumentation
 */

import type { ToolCapability, ToolMetaTag } from './capabilities.js';

/**
 * Composite value emitted by the CapabilityPicker widget.
 * Controls four schema fields via a single widget.
 * @param allowedCapabilities - Capabilities explicitly allowed (present = allowed in three-state model)
 * @param disallowedCapabilities - Capabilities explicitly disallowed (present = disallowed in three-state model)
 * @param allowedTools - Raw tool name overrides that bypass capability filtering
 * @param disallowedTools - Raw tool names explicitly blocked
 */
export interface CapabilityPickerValue {
  /** Capabilities explicitly allowed (three-state: present = allowed). */
  allowedCapabilities: ToolCapability[];
  /** Capabilities explicitly disallowed (three-state: present = disallowed). */
  disallowedCapabilities: ToolCapability[];
  /** Raw tool name overrides that bypass capability filtering. */
  allowedTools: string[];
  /** Raw tool names explicitly blocked. */
  disallowedTools: string[];
}

/**
 * A capability with its resolved tools and meta-tags, ready for rendering.
 * @param capability - Canonical capability identifier
 * @param label - Human-readable label derived from capability
 * @param resolvedTools - Tool names in the active harness that declare this capability
 * @param metaTags - Computed meta-tags for tools with only this capability
 */
export interface CapabilityItem {
  /** Canonical capability identifier. */
  capability: ToolCapability;
  /** Human-readable label (derived from capability, e.g., 'file.read' → 'File Read'). */
  label: string;
  /** Tool names in the active harness that declare this capability. */
  resolvedTools: string[];
  /** Computed meta-tags for tools with only this capability. */
  metaTags: ToolMetaTag[];
}

/**
 * Capabilities grouped by dotted-namespace prefix for rendering.
 * @param label - Group label (e.g., 'File', 'Shell', 'Search')
 * @param items - Capabilities in this group
 */
export interface CapabilityGroup {
  /** Group label (e.g., 'File', 'Shell', 'Search', 'Network', 'Process'). */
  label: string;
  /** Capabilities in this group. */
  items: CapabilityItem[];
}

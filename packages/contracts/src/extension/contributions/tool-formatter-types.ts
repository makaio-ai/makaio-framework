/**
 * Tool call formatter types for package declarations.
 *
 * Defines the formatter declaration shape that packages use to contribute tool
 * call formatters. The UI layer bridges these declarations to the
 * `ToolCallFormatterRegistry`.
 * @packageDocumentation
 */

import type { PayloadFilter } from '@makaio/core';

/** Discriminated content types for formatted tool call output. */
export type PluginTransformedContentType = 'markdown';

/** Formatted content block for tool call display. */
export interface PluginTransformedContent {
  /** Content rendering strategy. */
  type: PluginTransformedContentType;
  /** Content string interpreted according to `type`. */
  content: string;
}

/**
 * Output from a tool call formatter (package-side declaration).
 *
 * All fields are optional — formatters can override any subset.
 */
export interface PluginFormattedToolCallOutput {
  /** Replaces the tool name in the block header. */
  label?: string;
  /** Replaces the Arguments section. */
  content?: PluginTransformedContent;
  /** Replaces the Output section rendering. */
  outputContent?: PluginTransformedContent;
}

/** Input shape passed to a formatter's `format` function. */
export interface PluginToolCallFormatterInput {
  /** Name of the tool being called. */
  toolName: string;
  /** Arguments passed to the tool. */
  args: Record<string, unknown>;
  /** Current status of the tool call. */
  status: 'pending' | 'running' | 'completed' | 'error';
  /** Output from the tool when the call has completed. */
  output?: string;
}

/**
 * A tool call formatter declaration contributed by a package.
 *
 * Structurally compatible with `ToolCallFormatterDefinition` used by the
 * UI registry, so the package loader can register declarations directly
 * without bridging.
 */
export interface ToolCallFormatterDeclaration {
  /** Unique identifier for this formatter. */
  id: string;
  /**
   * Declarative filter matched against the tool call input shape.
   *
   * Uses a `PayloadFilter` with dot-path support (e.g. `'args.subagent_type'`).
   * All conditions are ANDed.
   */
  filter: PayloadFilter;
  /**
   * Priority for ordering when multiple formatters match.
   *
   * Lower number = higher priority (checked first). Default: `50`.
   */
  priority: number;
  /**
   * Pure function that transforms a tool call block into formatted output.
   *
   * Returns `undefined` if the formatter decides not to handle this specific
   * call, falling through to the next formatter.
   * @param input - The tool call block data.
   * @returns Formatted output, or `undefined` to skip to the next formatter.
   */
  format: (input: PluginToolCallFormatterInput) => PluginFormattedToolCallOutput | undefined;
}

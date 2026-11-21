/**
 * Tool call formatter types for package declarations.
 *
 * Defines the formatter declaration shape that packages use to contribute tool
 * call formatters. The UI layer bridges these declarations to the host's
 * tool-call formatter registry.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { Condition } from '../../shared/condition.js';

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

/**
 * Input shape passed to a formatter's `format` function.
 *
 * Also the context a formatter's `when` condition is evaluated over, and the schema the
 * registry checks that condition against: the root is closed, so a field the formatter
 * input does not have (a typo, or `toolCallId`) is rejected at registration.
 */
export const ToolCallFormatterInputSchema = z.strictObject({
  /** Name of the tool being called. */
  toolName: z.string(),
  /** Arguments passed to the tool. */
  args: z.record(z.string(), z.unknown()),
  /** Current status of the tool call. */
  status: z.enum(['pending', 'running', 'completed', 'error']),
  /** Output from the tool when the call has completed. */
  output: z.string().optional(),
});

/** @see {@link ToolCallFormatterInputSchema} */
export type PluginToolCallFormatterInput = z.infer<typeof ToolCallFormatterInputSchema>;

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
   * Condition that selects the tool calls this formatter applies to.
   *
   * Evaluated over the formatter input object itself: `toolName`, `args`, `status`, and
   * `output` are at the root, with no `payload.` prefix. Field paths use dot notation,
   * for example `args.subagent_type`. A condition that cannot be evaluated (a failing
   * `$expr`) means the formatter does not apply.
   */
  when: Condition;
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

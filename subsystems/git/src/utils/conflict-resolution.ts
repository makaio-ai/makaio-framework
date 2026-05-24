/**
 * Conflict resolution utilities for parsing and resolving git merge conflicts.
 *
 * Pure functions with no bus dependency. Supports both standard and diff3 conflict markers.
 * @packageDocumentation
 */

// --- Marker patterns ---

/** Standard conflict marker: `<<<<<<< ref` */
const MARKER_OURS = /^<{7} (.+)$/;
/** Diff3 base marker: `||||||| ref` */
const MARKER_BASE = /^\|{7} (.+)$/;
/** Separator between sides: `=======` */
const MARKER_SEPARATOR = /^={7}$/;
/** End marker: `>>>>>>> ref` */
const MARKER_THEIRS = /^>{7} (.+)$/;

// --- Types ---

/**
 * A single conflict region parsed from file content.
 * Line numbers are 1-based and inclusive.
 */
export interface ConflictRegion {
  /** 1-based start line of the opening `<<<<<<<` marker */
  startLine: number;
  /** 1-based end line of the closing `>>>>>>>` marker */
  endLine: number;
  /** Content from "ours" side (current branch) */
  ours: string;
  /** Content from "theirs" side (incoming branch) */
  theirs: string;
  /** Content from the common ancestor (only present with diff3 markers) */
  base?: string;
  /** Ref label from the ours marker (e.g., "HEAD") */
  oursLabel: string;
  /** Ref label from the theirs marker (e.g., "feature-branch") */
  theirsLabel: string;
  /** Ref label from the base marker, if present */
  baseLabel?: string;
}

/** How to resolve a conflict. */
export type ConflictResolutionKind = 'ours' | 'theirs' | 'manual';

/** Resolution instruction for a single conflict. */
export interface ConflictResolution {
  /** Index into the regions array returned by {@link parseConflictMarkers} */
  regionIndex: number;
  /** Which side to keep, or 'manual' for custom content */
  resolution: ConflictResolutionKind;
  /** Custom content when resolution is 'manual'. Ignored otherwise. */
  manualContent?: string;
}

// --- Parser state machine ---

/** Internal parse states for the conflict marker FSM */
type ParseState = 'clean' | 'ours' | 'base' | 'theirs';

/** Mutable parser context shared across state handlers. */
interface ParserContext {
  state: ParseState;
  startLine: number;
  oursLabel: string;
  theirsLabel: string;
  baseLabel: string | undefined;
  oursLines: string[];
  baseLines: string[];
  theirsLines: string[];
}

/**
 * Create a fresh parser context in the 'clean' state.
 * @returns A new parser context with all fields reset
 */
function createParserContext(): ParserContext {
  return {
    state: 'clean',
    startLine: 0,
    oursLabel: '',
    theirsLabel: '',
    baseLabel: undefined,
    oursLines: [],
    baseLines: [],
    theirsLines: [],
  };
}

/**
 * Reset context to clean, optionally starting a new ours region.
 * @param ctx - Mutable parser context
 * @param line - Current source line (may contain an ours marker)
 * @param lineNum - 1-based line number
 */
function resetAndStartOurs(ctx: ParserContext, line: string, lineNum: number): void {
  Object.assign(ctx, createParserContext());
  const m = line.match(MARKER_OURS);
  if (m) {
    ctx.state = 'ours';
    ctx.startLine = lineNum;
    ctx.oursLabel = m[1];
  }
}

/**
 * Emit a completed region and reset context.
 * @param ctx - Mutable parser context
 * @param regions - Accumulator for completed regions
 * @param lineNum - 1-based line number of the closing marker
 * @param theirsLabel - Ref label from the theirs marker
 */
function emitRegion(ctx: ParserContext, regions: ConflictRegion[], lineNum: number, theirsLabel: string): void {
  regions.push({
    startLine: ctx.startLine,
    endLine: lineNum,
    ours: ctx.oursLines.join('\n'),
    theirs: ctx.theirsLines.join('\n'),
    ...(ctx.baseLabel !== undefined ? { base: ctx.baseLines.join('\n'), baseLabel: ctx.baseLabel } : {}),
    oursLabel: ctx.oursLabel,
    theirsLabel,
  });
  Object.assign(ctx, createParserContext());
}

/**
 * Parse git conflict markers from file content.
 *
 * Handles both standard two-way and diff3 three-way conflict markers.
 * Invalid or incomplete markers (e.g., missing `=======` or `>>>>>>>`) are skipped.
 * @param content - Raw file content with potential conflict markers
 * @returns Array of parsed conflict regions, ordered by position
 */
export function parseConflictMarkers(content: string): ConflictRegion[] {
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const regions: ConflictRegion[] = [];
  const ctx = createParserContext();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (ctx.state === 'clean') {
      const m = line.match(MARKER_OURS);
      if (m) {
        ctx.state = 'ours';
        ctx.startLine = lineNum;
        ctx.oursLabel = m[1];
      }
    } else if (ctx.state === 'ours') {
      processOursLine(ctx, regions, line, lineNum);
    } else if (ctx.state === 'base') {
      processBaseLine(ctx, line, lineNum);
    } else {
      processTheirsLine(ctx, regions, line, lineNum);
    }
  }

  return regions;
}

/**
 * Handle a line while in the 'ours' state.
 * @param ctx - Mutable parser context
 * @param regions - Accumulator for completed regions
 * @param line - Current source line
 * @param lineNum - 1-based line number
 */
function processOursLine(ctx: ParserContext, regions: ConflictRegion[], line: string, lineNum: number): void {
  const bMatch = line.match(MARKER_BASE);
  if (bMatch) {
    ctx.state = 'base';
    ctx.baseLabel = bMatch[1];
    return;
  }
  if (MARKER_SEPARATOR.test(line)) {
    ctx.state = 'theirs';
    return;
  }
  if (MARKER_OURS.test(line)) {
    resetAndStartOurs(ctx, line, lineNum);
    return;
  }
  ctx.oursLines.push(line);
}

/**
 * Handle a line while in the 'base' state.
 * @param ctx - Mutable parser context
 * @param line - Current source line
 * @param lineNum - 1-based line number
 */
function processBaseLine(ctx: ParserContext, line: string, lineNum: number): void {
  if (MARKER_SEPARATOR.test(line)) {
    ctx.state = 'theirs';
    return;
  }
  if (MARKER_OURS.test(line)) {
    resetAndStartOurs(ctx, line, lineNum);
    return;
  }
  ctx.baseLines.push(line);
}

/**
 * Handle a line while in the 'theirs' state.
 * @param ctx - Mutable parser context
 * @param regions - Accumulator for completed regions
 * @param line - Current source line
 * @param lineNum - 1-based line number
 */
function processTheirsLine(ctx: ParserContext, regions: ConflictRegion[], line: string, lineNum: number): void {
  const tMatch = line.match(MARKER_THEIRS);
  if (tMatch) {
    emitRegion(ctx, regions, lineNum, tMatch[1]);
    return;
  }
  if (MARKER_OURS.test(line)) {
    resetAndStartOurs(ctx, line, lineNum);
    return;
  }
  ctx.theirsLines.push(line);
}

/**
 * Quick check whether file content contains unresolved conflict markers.
 *
 * This is intentionally cheaper than a full parse -- it only scans for opening markers.
 * @param content - Raw file content
 * @returns `true` if at least one `<<<<<<<` marker is found
 */
export function hasConflictMarkers(content: string): boolean {
  // Multiline mode makes ^ match both the first line and lines after '\n',
  // so start-of-file markers are detected without requiring a leading newline.
  return /^<{7} .+$/m.test(content);
}

/**
 * Resolve a single conflict region within file content.
 *
 * Replaces the conflict block (from `<<<<<<<` through `>>>>>>>`) with the chosen content.
 * @param content - Full file content containing conflict markers
 * @param region - The conflict region to resolve
 * @param resolution - Which side to keep
 * @param manualContent - Custom replacement text when resolution is 'manual'
 * @returns Updated file content with the specified conflict resolved
 * @throws Error if resolution is 'manual' but manualContent is not provided
 */
export function resolveConflict(
  content: string,
  region: ConflictRegion,
  resolution: ConflictResolutionKind,
  manualContent?: string,
): string {
  const replacement = getReplacementContent(region, resolution, manualContent);
  return replaceRegion(content, region, replacement);
}

/**
 * Apply multiple conflict resolutions to a file at once.
 *
 * Resolutions are applied in reverse order (bottom-to-top) so that line numbers
 * remain valid as earlier regions shift content.
 * @param content - Full file content containing conflict markers
 * @param regions - All conflict regions from {@link parseConflictMarkers}
 * @param resolutions - Resolution instructions (one per region to resolve)
 * @returns Updated file content with all specified conflicts resolved
 * @throws Error if any regionIndex is out of bounds
 * @throws Error if a 'manual' resolution lacks manualContent
 */
export function resolveAllConflicts(
  content: string,
  regions: readonly ConflictRegion[],
  resolutions: readonly ConflictResolution[],
): string {
  // Sort resolutions by regionIndex descending so bottom replacements happen first
  const sorted = [...resolutions].sort((a, b) => b.regionIndex - a.regionIndex);

  let result = content;
  for (const res of sorted) {
    if (res.regionIndex < 0 || res.regionIndex >= regions.length) {
      throw new Error(`Region index ${String(res.regionIndex)} is out of bounds (0..${String(regions.length - 1)})`);
    }
    const region = regions[res.regionIndex];
    const replacement = getReplacementContent(region, res.resolution, res.manualContent);
    result = replaceRegion(result, region, replacement);
  }

  return result;
}

// --- Internal helpers ---

/**
 * Determine the replacement content for a conflict resolution.
 * @param region - Conflict region being resolved
 * @param resolution - Resolution strategy
 * @param manualContent - Custom content for 'manual' resolution
 * @returns The text to replace the conflict block with
 */
function getReplacementContent(
  region: ConflictRegion,
  resolution: ConflictResolutionKind,
  manualContent?: string,
): string {
  switch (resolution) {
    case 'ours':
      return region.ours;
    case 'theirs':
      return region.theirs;
    case 'manual':
      if (manualContent === undefined) {
        throw new Error('manualContent is required for manual resolution');
      }
      return manualContent;
  }
}

/**
 * Replace a conflict region (startLine..endLine) with replacement text.
 * @param content - Full file content
 * @param region - Region to replace
 * @param replacement - Replacement text
 * @returns Updated content
 */
function replaceRegion(content: string, region: ConflictRegion, replacement: string): string {
  const lines = content.split('\n');
  // Convert 1-based inclusive range to 0-based splice params
  const startIdx = region.startLine - 1;
  const deleteCount = region.endLine - region.startLine + 1;

  // Split replacement into lines; empty replacement removes the block entirely
  const replacementLines = replacement === '' ? [] : replacement.split('\n');

  lines.splice(startIdx, deleteCount, ...replacementLines);
  return lines.join('\n');
}

/**
 * Git blame query - parse `git blame --porcelain` output.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { GitBlameLine, GitBlameResponse } from '../schemas.js';

/**
 * Parsed state for a single blame block from porcelain output.
 */
interface PorcelainBlock {
  /** Full commit hash */
  hash: string;
  /** Original line number in the blamed commit */
  originalLine: number;
  /** Final line number in the current file */
  finalLine: number;
  /** Number of lines in this group */
  numLines: number;
  /** Author name */
  author: string;
  /** Author timestamp (unix epoch) */
  authorTime: number;
  /** Commit summary line */
  summary: string;
}

/**
 * Parse `git blame --porcelain` output into structured blame data.
 *
 * Porcelain format emits blocks of the form:
 * ```
 * <hash> <orig-line> <final-line> <num-lines>
 * author <name>
 * author-mail <email>
 * author-time <timestamp>
 * author-tz <tz>
 * committer <name>
 * committer-mail <email>
 * committer-time <timestamp>
 * committer-tz <tz>
 * summary <message>
 * [previous <hash> <filename>]
 * filename <path>
 * \t<content-line>
 * ```
 *
 * Subsequent lines from the same commit omit the header fields and only
 * include the hash line and the content line prefixed with a tab.
 * @param raw - Raw porcelain blame output
 * @returns Array of parsed blame blocks (one per content line)
 */
function parsePorcelainBlame(raw: string): PorcelainBlock[] {
  const lines = raw.split('\n');
  const blocks: PorcelainBlock[] = [];
  /** Cache of header info by commit hash */
  const commitCache = new Map<string, { author: string; authorTime: number; summary: string }>();

  let current: Partial<PorcelainBlock> | null = null;

  for (const line of lines) {
    // Header line: <40-char-hash> <orig> <final> [<num-lines>]
    // Accept SHA-1 (40 hex) and SHA-256 (64 hex) hashes
    const headerMatch = line.match(/^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/);
    if (headerMatch) {
      current = {
        hash: headerMatch[1],
        originalLine: parseInt(headerMatch[2], 10),
        finalLine: parseInt(headerMatch[3], 10),
        numLines: headerMatch[4] ? parseInt(headerMatch[4], 10) : 1,
      };

      // Pre-populate from cache if available
      const cached = commitCache.get(current.hash!);
      if (cached) {
        current.author = cached.author;
        current.authorTime = cached.authorTime;
        current.summary = cached.summary;
      }
      continue;
    }

    if (!current) continue;

    // Parse header fields
    if (line.startsWith('author ')) {
      current.author = line.slice(7);
    } else if (line.startsWith('author-time ')) {
      current.authorTime = parseInt(line.slice(12), 10);
    } else if (line.startsWith('summary ')) {
      current.summary = line.slice(8);
    } else if (line.startsWith('\t')) {
      // Content line - finalize this block
      const block = current as PorcelainBlock;

      // Cache commit info for subsequent references
      if (!commitCache.has(block.hash)) {
        commitCache.set(block.hash, {
          author: block.author,
          authorTime: block.authorTime,
          summary: block.summary,
        });
      }

      blocks.push(block);
      current = null;
    }
    // Skip other header fields (author-mail, committer-*, filename, previous, etc.)
  }

  return blocks;
}

/**
 * Collapse consecutive blame blocks with the same commit into line ranges.
 * @param blocks - Parsed porcelain blocks (one per line)
 * @returns Collapsed blame lines with start/end ranges
 */
function collapseBlameRanges(blocks: PorcelainBlock[]): GitBlameLine[] {
  if (blocks.length === 0) return [];

  const ranges: GitBlameLine[] = [];
  let currentRange: GitBlameLine | null = null;

  for (const block of blocks) {
    const date = new Date(block.authorTime * 1000).toISOString();

    if (currentRange && currentRange.hash === block.hash && currentRange.endLine === block.finalLine - 1) {
      // Extend existing range
      currentRange.endLine = block.finalLine;
    } else {
      // Start a new range
      currentRange = {
        startLine: block.finalLine,
        endLine: block.finalLine,
        shortHash: block.hash.slice(0, 7),
        hash: block.hash,
        author: block.author,
        date,
        message: block.summary,
      };
      ranges.push(currentRange);
    }
  }

  return ranges;
}

/**
 * Get blame annotations for a file at a given revision.
 * @param git - SimpleGit instance
 * @param filePath - File path relative to repository root
 * @param ref - Git ref (defaults to HEAD)
 * @returns Blame response with file content and line annotations
 */
export async function getBlame(git: SimpleGit, filePath: string, ref?: string): Promise<GitBlameResponse> {
  const args = ['blame', '--porcelain'];
  if (ref) {
    args.push(ref);
  }
  args.push('--', filePath);

  const raw = await git.raw(args);
  const blocks = parsePorcelainBlame(raw);
  const blameLines = collapseBlameRanges(blocks);

  // Get file content at the revision
  const contentRef = ref ?? 'HEAD';
  const content = await git.show([`${contentRef}:${filePath}`]);

  return { content, lines: blameLines };
}

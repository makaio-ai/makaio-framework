/**
 * Unit tests for the pure merged-list helpers that shape the list `dispatch()` walks.
 *
 * Covers `markCoveredRemoteHops`: one remote hop per transport and walk, counted only
 * from the walk's start index so a walk re-entered with a lower cursor can still reach a
 * peer's lower tiers, and covered entries kept as the cursor boundaries
 * `resolveRemoteCursor` reads. Covers `nextExecutableEntry`: covered entries are passed
 * over without being executed, and a walk ending in covered entries is exhausted.
 */

import { describe, expect, it } from 'vitest';
import type { RequestHandler } from '@makaio/core';
import {
  buildMergedList,
  markCoveredRemoteHops,
  nextExecutableEntry,
  resolveRemoteCursor,
  resolveStartIndex,
  type MergedEntry,
} from '../methods/request/merged-list.js';

const noopHandler: RequestHandler<unknown, unknown> = () => undefined;

/**
 * Render merged entries as compact labels so assertions read like the walk order.
 * @param entries - Merged entries to describe
 * @returns One `local@<priority>`, `<transport>@<priority>` or `covered:<transport>@<priority>`
 *   label per entry
 */
function labels(entries: ReadonlyArray<MergedEntry>): string[] {
  return entries.map((entry) => {
    if (entry.kind === 'local') return `local@${entry.priority}`;
    const label = `${entry.transport}@${entry.priority}`;
    return entry.kind === 'covered' ? `covered:${label}` : label;
  });
}

describe('markCoveredRemoteHops', () => {
  const merged = buildMergedList(
    [{ handler: noopHandler, priority: 250 }],
    [
      { transport: 'peer', priority: 300 },
      { transport: 'peer', priority: 200 },
    ],
  );

  it('keeps only the first entry of a transport sendable in a walk from the head', () => {
    expect(labels(merged)).toEqual(['peer@300', 'local@250', 'peer@200']);

    expect(labels(markCoveredRemoteHops(merged, 0))).toEqual(['peer@300', 'local@250', 'covered:peer@200']);
  });

  it('does not count entries before the start index, so a re-entered walk still reaches lower tiers', () => {
    // A hop from `peer` with cursor 300 re-enters this node below its first entry.
    const startIndex = resolveStartIndex(merged, 300);
    expect(startIndex).toBe(1);

    const walk = markCoveredRemoteHops(merged, startIndex);

    expect(labels(walk)).toEqual(['peer@300', 'local@250', 'peer@200']);
    expect(walk[startIndex]).toBe(merged[startIndex]);
  });

  it('covers per transport and never touches local entries', () => {
    const mixed = buildMergedList(
      [
        { handler: noopHandler, priority: 290 },
        { handler: noopHandler, priority: 100 },
      ],
      [
        { transport: 'left', priority: 300 },
        { transport: 'right', priority: 280 },
        { transport: 'left', priority: 200 },
        { transport: 'right', priority: 100 },
      ],
    );

    expect(labels(markCoveredRemoteHops(mixed, 0))).toEqual([
      'left@300',
      'local@290',
      'right@280',
      'covered:left@200',
      'local@100',
      'covered:right@100',
    ]);
  });

  it("keeps a covered entry's priority as the next hop's cursor boundary", () => {
    // `left` advertises 300 and 200, `right` only 200. The walk's single hop to `left`
    // already ran its 200 tier, so `right` must start below 200 (cursor 201 with the
    // equal-priority bump), not below 300: a 250 handler on `right` would otherwise run
    // after `left`'s 200 handler.
    const walk = markCoveredRemoteHops(
      buildMergedList(
        [],
        [
          { transport: 'left', priority: 300 },
          { transport: 'left', priority: 200 },
          { transport: 'right', priority: 200 },
        ],
      ),
      0,
    );

    expect(labels(walk)).toEqual(['left@300', 'covered:left@200', 'right@200']);
    expect(resolveRemoteCursor(walk, 3, 200, undefined)).toBe(201);
  });
});

describe('resolveRemoteCursor', () => {
  it('never widens the incoming cursor when the predecessor lies before the start index', () => {
    // Entered with cursor 300: `upper@400` is skipped, so `lower@200` is the first entry
    // this node walks. Its predecessor's 400 must not reopen the 300..399 range.
    const merged = buildMergedList(
      [],
      [
        { transport: 'upper', priority: 400 },
        { transport: 'lower', priority: 200 },
      ],
    );
    const startIndex = resolveStartIndex(merged, 300);
    expect(startIndex).toBe(1);

    expect(resolveRemoteCursor(markCoveredRemoteHops(merged, startIndex), startIndex + 1, 200, 300)).toBe(300);
  });
});

describe('nextExecutableEntry', () => {
  const walk = markCoveredRemoteHops(
    buildMergedList(
      [{ handler: noopHandler, priority: 150 }],
      [
        { transport: 'peer', priority: 300 },
        { transport: 'peer', priority: 200 },
        { transport: 'peer', priority: 100 },
      ],
    ),
    0,
  );

  it('passes over covered entries to the next executable entry', () => {
    expect(labels(walk)).toEqual(['peer@300', 'covered:peer@200', 'local@150', 'covered:peer@100']);

    expect(nextExecutableEntry(walk, 0)?.index).toBe(0);
    expect(nextExecutableEntry(walk, 1)).toEqual({ entry: walk[2], index: 2 });
  });

  it('reports exhaustion when only covered entries remain', () => {
    expect(nextExecutableEntry(walk, 3)).toBeUndefined();
    expect(nextExecutableEntry(walk, walk.length)).toBeUndefined();
  });
});

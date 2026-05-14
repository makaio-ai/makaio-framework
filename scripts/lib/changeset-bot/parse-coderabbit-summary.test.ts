import { describe, expect, it } from 'vitest';
import { parseCodeRabbitChanges } from './parse-coderabbit-summary.js';

const REALISTIC_COMMENT = `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->
<!-- skip review stuff -->

<!-- walkthrough_start -->

<details>
<summary>📝 Walkthrough</summary>

## Walkthrough
Implements detached child-process execution: contracts and parser,
subprocess JSONL/RPC/lifecycle, stdio transports, Node runtime
synthesis and boot, MCP tool bridge.

## Changes

**Detached extensions end-to-end**

|Layer / File(s)|Summary|
|---|---|
|**Data/Contracts** <br> \`framework/packages/contracts/src/extension/*\`, \`framework/packages/contracts/src/index.ts\`|Adds DetachedTransportSchema.|
|**Subprocess infra** <br> \`framework/packages/subprocess/*\`|New workspace package.|
|**StdIO transports** <br> \`framework/transports/stdio/*\`, \`framework/transports/stdio/package.json\`|Adds JSONL framing helpers.|
|**Adapter refactor** <br> \`framework/adapters/implementations/codex-app-server/*\`|Refactors JSON-RPC client.|
|**Host build** <br> \`host/apps/server/*\`|Bundles now require EmbeddedDescriptor.|
|**Tests** <br> \`**/__tests__/**\`|Adds extensive tests.|

</details>

<!-- walkthrough_end -->`;

const SKIPPED_REVIEW = `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->
<!-- This is an auto-generated comment: skip review by coderabbit.ai -->

> [!IMPORTANT]
> ## Review skipped
> Auto reviews are limited based on label configuration.`;

describe('parseCodeRabbitChanges', () => {
  it('extracts rows with paths and summaries from a realistic comment', () => {
    const rows = parseCodeRabbitChanges(REALISTIC_COMMENT);

    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      paths: ['framework/packages/contracts/src/extension/', 'framework/packages/contracts/src/index.ts'],
      summary: 'Adds DetachedTransportSchema.',
    });
    expect(rows[1]).toEqual({
      paths: ['framework/packages/subprocess/'],
      summary: 'New workspace package.',
    });
  });

  it('normalizes glob wildcards to directory prefixes', () => {
    const rows = parseCodeRabbitChanges(REALISTIC_COMMENT);
    const allPaths = rows.flatMap((r) => r.paths);

    expect(allPaths).toContain('framework/packages/subprocess/');
    expect(allPaths.some((p) => p.includes('*'))).toBe(false);
  });

  it('handles deep globs like **/__tests__/**', () => {
    const rows = parseCodeRabbitChanges(REALISTIC_COMMENT);
    const allPaths = rows.flatMap((r) => r.paths);
    expect(allPaths).toContain('__tests__/');
  });

  it('returns empty array when no walkthrough section exists', () => {
    expect(parseCodeRabbitChanges(SKIPPED_REVIEW)).toEqual([]);
  });

  it('returns empty array when no Changes heading exists', () => {
    const comment = `<!-- walkthrough_start -->
<details>
<summary>📝 Walkthrough</summary>

## Walkthrough
Just a summary, no changes.

</details>`;

    expect(parseCodeRabbitChanges(comment)).toEqual([]);
  });

  it('skips table header and separator rows', () => {
    const comment = `<!-- walkthrough_start -->
<details>
<summary>📝 Walkthrough</summary>

## Walkthrough
Summary.

## Changes

|Layer / File(s)|Summary|
|---|---|
|**Code** <br> \`src/real.ts\`|real change|

</details>`;

    const rows = parseCodeRabbitChanges(comment);
    expect(rows).toHaveLength(1);
    expect(rows[0].paths).toEqual(['src/real.ts']);
    expect(rows[0].summary).toBe('real change');
  });

  it('extracts multiple paths from a single row', () => {
    const comment = `<!-- walkthrough_start -->
<details>
<summary>📝 Walkthrough</summary>

## Walkthrough
Summary.

## Changes

|File|Summary|
|---|---|
|**Files** <br> \`src/a.ts\`, \`src/b.ts\`|Two files changed.|

</details>`;

    const rows = parseCodeRabbitChanges(comment);
    expect(rows[0].paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('strips bold and HTML from summary cells', () => {
    const comment = `<!-- walkthrough_start -->
<details>
<summary>📝 Walkthrough</summary>

## Walkthrough
Summary.

## Changes

|File|Summary|
|---|---|
|**Code** <br> \`src/foo.ts\`|**Bold** summary with <br> tag.|

</details>`;

    const rows = parseCodeRabbitChanges(comment);
    expect(rows[0].summary).toBe('Bold summary with  tag.');
  });

  it('escapes incomplete HTML tags from summary cells', () => {
    const comment = `<!-- walkthrough_start -->
<details>
<summary>📝 Walkthrough</summary>

## Walkthrough
Summary.

## Changes

|File|Summary|
|---|---|
|**Code** <br> \`src/foo.ts\`|Adds incomplete <script payload.|

</details>`;

    const rows = parseCodeRabbitChanges(comment);
    expect(rows[0].summary).toBe('Adds incomplete &lt;script payload.');
  });
});

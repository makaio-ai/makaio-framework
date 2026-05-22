# Makaio — CodeRabbit

CodeRabbit integration extension. Registers the `CodeRabbitSource` and `codeRabbitProcessor` with the capability bus so the `review` extension can fetch and normalize raw CodeRabbit VCS data into `ReviewFinding` records.

## What It Provides

| Surface | Detail |
|---------|--------|
| Background service | Registers `CodeRabbitSource` and `codeRabbitProcessor` with the capability bus on `init` |
| Review source | `review-source` with id `coderabbit`, VCS-agnostic snapshot fetching |
| Capability | `reviewer-processor` with key `makaio/coderabbit`, reviewer family `coderabbit` |
| Workflow blocks | Trigger: `coderabbit.review-posted`; Step: `coderabbit.fetch-findings` |

This extension contributes no CLI commands, tools, or storage of its own. All findings management is handled by the `review` extension.

## How CodeRabbit Findings Are Processed

CodeRabbit posts findings in two tiers:

**1. Inline comments** (`coderabbitai[bot]` author, file-level diff comments)

Each comment is parsed for:
- **Severity** — detected from emoji markers: `🔴`/`🚨` → `critical`, `⚠️`/`Potential issue` → `major`, `🟡`/`Minor` → `minor`, `🧹`/`Nitpick` → `nitpick`.
- **Summary** — first bold Markdown sentence.
- **Explanation** — prose paragraph following the summary, before the first `<details>` block.
- **Suggested fix** — unified diff inside a `🔧 Suggested fix` details block, parsed into structured `SuggestedChange` entries.
- **Agent prompt** — content from the `🤖 Prompt for AI Agents` details block, stripped of HTML and ready for direct AI agent use.
- **Stable ID** — `<sourceId>:inline:<commentId>` (or path+line composite fallback).

Reply comments and general PR comments (no file path) are skipped.

**2. Review body nitpicks** (consolidated in the review body, not posted inline)

Nitpick findings are extracted from the `🧹 Nitpick comments` `<details>` block in review bodies. Each file has its own nested `<details>` section; findings are split on `---` separators. IDs use a content hash for stability since there is no raw comment ID anchor.

**Rate limit parsing**

CodeRabbit embeds rate limit state in HTML comment markers (`<!-- review_rate_limit_status_start -->`). The processor exposes `parseRateLimitFromBody(body)` so review sources can surface remaining request counts and reset times.

**HTML metadata stripping**

HTML comments used for CodeRabbit's internal fingerprinting and base64 state blobs are stripped before any parsing so they do not contaminate message text.

## Finding ID Format

| Origin | ID pattern |
|--------|-----------|
| Inline comment (with ID) | `<sourceId>:inline:<commentId>` |
| Inline comment (no ID) | `<sourceId>:inline:<threadId>:<path>:<line>` |
| Review-body nitpick | `<sourceId>:review-body:<reviewId>:<file>:<line>:<contentHash>` |

IDs are stable across fetches: the same comment always produces the same ID so reconciliation can detect resolved findings without false re-opens.

## Dependency

Requires the `review` extension to be loaded and running. The extension declares `dep('review')`, so descriptor-driven startup treats that as a hard activation dependency.

## Installation

```bash
makaio extension install ./extensions/coderabbit
makaio extension install ./extensions/review
```

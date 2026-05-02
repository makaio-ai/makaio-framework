# @makaio/extension-pin-message

Reference implementation for session event actions.

Demonstrates two action modes against session events:

- **Single-mode action** (`pin-message:pin`) — immediate add-only pin action from the message kebab menu; it appears only for messages that are not already pinned.
- **Multi-mode action** (`pin-message:summarize`) — opens the selection picker, reports a rough token estimate, and logs execution as a summarization placeholder.

Storage is process-local in-memory state and resets on process restart.

## Features

- **Pin add** — pin a user or assistant message via the context menu
- **Summarize selection** — picker action demonstrating selection feedback and token estimates
- **In-memory storage** — bus handlers with no database dependency

## Session event actions registered

| Action ID | Mode | Description |
|-----------|------|-------------|
| `pin-message:pin` | single | Adds the target message to process-local pin storage |
| `pin-message:summarize` | multi | Opens the picker and returns token-estimate feedback; execution is a placeholder log |

`pin-message:summarize` does not expose a summarization strategy picker.

## Config

No configuration schema.

## File Index

| File | Description |
|------|-------------|
| [`src/index.ts`](src/index.ts) | Extension package descriptor |
| [`src/actions.ts`](src/actions.ts) | Action definitions |
| [`src/storage.ts`](src/storage.ts) | In-memory pin storage handlers |

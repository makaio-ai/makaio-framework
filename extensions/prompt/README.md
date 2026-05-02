# Makaio Prompt

Provider-agnostic CLI for sending prompts to any AI provider through the Makaio bus. Drop-in replacement for `claude -p` that works with Claude, GPT, Gemini, Codex, Qwen, and any other adapter.

## Prerequisites

The Makaio runtime must be running with at least one configured adapter:

```bash
makaio serve
```

## Usage

```bash
# Basic prompt
makaio prompt send "Explain event sourcing in 3 sentences" --model sonnet

# Pipe from stdin
echo "Summarize this file" | makaio prompt send --model gpt-5.2

# With tool access (auto-approve all tool calls)
makaio prompt send "List all TypeScript files in src/" \
  --model sonnet \
  --allowed-tools "Read,Bash" \
  --dangerously-skip-permissions

# JSON output for scripting
makaio prompt send "What is 2+2?" --model sonnet --output-format json

# Streaming NDJSON for real-time processing
makaio prompt send "Write a haiku" --model sonnet --output-format stream-json
```

## Model Resolution

The `--model` flag accepts canonical model references. Makaio resolves them to the appropriate adapter and provider:

| Reference | Resolves to |
|-----------|-------------|
| `sonnet` | Default Anthropic adapter |
| `gpt-5.2` | Default OpenAI adapter |
| `gemini-2.5-pro` | Gemini adapter |
| `anthropic::sonnet` | Explicit provider routing |
| `openai-node/openai::gpt-5.2` | Explicit adapter + provider |

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--model <ref>` | `-m` | Canonical model reference |
| `--output-format <fmt>` | | `text` (default), `json`, `stream-json` |
| `--system-prompt <text>` | | Replace the default system prompt |
| `--append-system-prompt <text>` | | Append to the default system prompt |
| `--allowed-tools <list>` | | Tool allowlist (comma or space-separated) |
| `--disallowed-tools <list>` | | Tool denylist (comma or space-separated) |
| `--dangerously-skip-permissions` | | Auto-approve all tool calls |
| `--reasoning-effort <level>` | | `low`, `medium`, `high` |
| `--cwd <dir>` | | Working directory for the agent |
| `--session-id <uuid>` | | Reuse a specific session |
| `--timeout <seconds>` | | Overall timeout (default: 300) |

## Output Formats

**`text`** — Plain text, suitable for terminal and pipes:
```
Here's the answer to your question.
```

**`json`** — Single JSON envelope after completion:
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 4238,
  "result": "Here's the answer...",
  "session_id": "958e15a7-...",
  "model": "sonnet",
  "usage": { "inputTokens": 18, "outputTokens": 113 }
}
```

**`stream-json`** — Real-time NDJSON, one event per line:
```jsonl
{"type":"system","subtype":"init","session_id":"...","model":"sonnet"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Here's"}]}}
{"type":"result","subtype":"success","duration_ms":4238,"result":"..."}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (server not running, model not found, turn failed) |
| `2` | Rate-limited by provider |
| `124` | Timeout |
| `130` | Interrupted (Ctrl-C) |

## Tool Permissions

Without `--dangerously-skip-permissions`, tool calls require interactive approval. In a non-interactive context (scripts, CI), unapproved tool calls are denied by default. For automated workflows, either:

- Pass `--dangerously-skip-permissions` to auto-approve everything
- Restrict the tool set with `--allowed-tools` to limit what can execute

## Migrating from `claude -p`

Most flags map directly:

```bash
# Before
claude -p "Review this code" --model sonnet --allowedTools "Read Edit"

# After
makaio prompt send "Review this code" --model sonnet --allowed-tools "Read Edit"
```

Key differences: `--allowedTools` becomes `--allowed-tools` (kebab-case), and `--effort` becomes `--reasoning-effort`.

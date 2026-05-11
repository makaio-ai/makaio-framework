# Makaio Account Manager

Automatic credential discovery and multi-account management for AI coding tools. Detects your accounts from Claude Code and Codex, tracks usage and rate limits, and lets you switch between accounts from the CLI or the desktop UI.

## What It Does

Most developers have multiple AI tool accounts — work and personal, different orgs, different plans. The account manager:

- **Discovers accounts automatically** by polling each tool's native credential storage
- **Tracks usage and rate limits** per account (utilization windows, reset times, credits)
- **Switches accounts** by writing the target credential back to the tool's native location
- **Persists across restarts** with platform-specific credential storage

## Supported Tools

| Tool | Credential Source | Usage Tracking |
|------|------------------|----------------|
| Claude Code | macOS Keychain service `Claude Code-credentials`; non-macOS `~/.claude/.credentials.json` | 5-hour and 7-day windows |
| Codex (OpenAI) | `~/.codex/auth.json` file mode | Primary and secondary windows |

Codex keyring mode is not read directly; the source reports a configuration issue and
the interactive TUI lets users press `f` to switch Codex to file-backed credential storage.

## CLI Usage

### Interactive TUI

```bash
makaio account-manager
```

Opens a terminal UI showing all accounts per tool with live usage gauges, status indicators, and keyboard navigation for switching.

### Subcommands

```bash
# List all detected accounts
makaio account-manager list
makaio account-manager list --format json

# Switch the active account
makaio account-manager switch <account-id>

# Label an account for easy identification
makaio account-manager label <account-id> "Work - Anthropic Team"

# Remove a remembered account
makaio account-manager remove <account-id>

# Show which credential sources are available
makaio account-manager sources

# Stream account and usage events as NDJSON (for scripting)
makaio account-manager watch
```

### Account Identification

Accounts are assigned stable UUIDs on first detection. Use `list` to find IDs, then reference them in `switch`, `label`, and `remove`. If `--client-id` is omitted, the CLI looks up the account ID across available sources and uses the owning client automatically.

## Browser UI

When running with the Makaio desktop app, the account manager contributes:

- **Tray widget** — quick account overview in the header
- **Dashboard widgets** — account list, usage KPIs, utilization bars
- **Analytics page** — usage heatmap, time-series history, window distribution charts

## How Discovery Works

The account manager polls each tool's credential storage every 5 seconds. When a new fingerprint appears, it creates a persistent account record. When you switch accounts outside Makaio (e.g., via `claude` CLI login), the change is detected automatically.

When the active account is detected or refreshed, the account manager also signals the resolved identity to the framework's client runtime service via `client.account.activate`. This allows standalone client processes that aren't part of a Makaio session (e.g. a Claude Code process running outside the desktop app) to have their usage attributed to the correct account via `client.account.getActive`.

On macOS, remembered credentials are stored in an AES-256-GCM encrypted file and the encryption key is stored in the macOS Keychain. On other platforms, remembered credentials are stored as plaintext JSON with `0600` file permissions, matching the file-backed storage model used by the supported native clients. Use full-disk encryption and restrict host account access when relying on plaintext file-backed storage.

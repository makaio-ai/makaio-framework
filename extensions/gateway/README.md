# LLM Gateway

Per-request Anthropic Messages router for Claude Code. Routes each request to
one of the named upstreams — either the official Anthropic API or a LiteLLM
proxy — based on the model identifier in the request body, letting a single
Claude Code session span subscription-backed Claude models and non-Anthropic
backends without changing base URLs or re-authenticating.

## What it does

For every `POST /v1/messages` and `POST /v1/messages/count_tokens` arriving at
`/gateway/v1/messages` (or `/gateway/v1/messages/count_tokens`), the gateway:

1. Reads the request body once and extracts `body.model`.
2. Walks the configured rule list in declaration order; the first matching rule
   selects a target upstream. When no rule matches, the request goes to the
   upstream named by `default`.
3. **Anthropic upstream without `auth`** — forwards the original body bytes
   unchanged, together with all non-hop-by-hop headers (`Authorization`,
   `x-api-key`, `anthropic-beta`, `anthropic-version`, and any others), to the
   configured Anthropic upstream URL. This keeps subscription OAuth tokens
   intact end-to-end.
4. **Anthropic upstream with `auth`** — sets `x-api-key` to the resolved API
   key, removes the `authorization` header, and forwards the original body bytes
   unchanged to the Anthropic upstream URL.
5. **LiteLLM upstream** — parses the body, optionally renames `model`, injects
   the configured reasoning-control fields, sets `Authorization: Bearer
   <masterKey>`, removes `x-api-key`, and forwards to `<url>/v1/messages` (or
   `/v1/messages/count_tokens`).
6. Streams the upstream response back to Claude Code without modification.
   Response bodies are never rewritten in either branch; error bodies are
   forwarded verbatim so Claude Code's retry logic can pattern-match on upstream
   error text.
7. Emits one `gateway.requestRouted` bus event per routed request.

## Prerequisites

- A running Makaio host that mounts extension HTTP routes: `makaio serve`, or a
  desktop host in production mode. The extension declares `surface: "any"`, so
  it loads in headless and interactive hosts alike. Desktop development mode
  does not expose extension HTTP routes because the dev server owns the
  request pipeline.
- A running LiteLLM proxy reachable at the configured `url` when any rule
  targets a LiteLLM upstream. The gateway assumes LiteLLM is already running;
  it does not manage the proxy process.
- Claude Code installed and configured (see [Claude Code setup](#claude-code-setup) below).

## Configuration

Gateway configuration is supplied through `packageConfigDefaults` in the runtime
config file, keyed by the extension descriptor name `"gateway"`. The `rules`
field is an array of objects that the settings form cannot render, so the config
file is the primary way to configure the gateway.

**Config file resolution order** (`resolveMakaioConfigPath`,
`runtimes/node/src/makaio-config.ts`):

1. `--config <path>` flag — must appear before the subcommand:
   `makaio --config ./makaio.config.json serve`.
2. `MAKAIO_CONFIG_FILE` environment variable.
3. `~/.makaio/makaio.config.ts` / `.js` / `.json`.

A `.ts` config uses `defineMakaioConfig` from `@makaio/runtime-node/makaio-config`
and may read `process.env` at load time. A `.json` config uses plain JSON.

**`makaio.config.json` example:**

```json
{
  "packageConfigDefaults": {
    "gateway": {
      "upstreams": {
        "anthropic": {
          "kind": "anthropic",
          "url": "https://api.anthropic.com"
        },
        "litellm": {
          "kind": "litellm",
          "url": "http://127.0.0.1:4000",
          "masterKey": "env:LITELLM_MASTER_KEY"
        }
      },
      "default": "anthropic",
      "accessToken": "env:GATEWAY_ACCESS_TOKEN",
      "maxBodyBytes": 67108864,
      "rules": [
        {
          "match": "DeepSeek-V4-Flash-0731",
          "to": "litellm",
          "reasoning": { "mode": "passthrough" }
        },
        {
          "match": "gpt-*",
          "to": "litellm",
          "model": "gpt-4o",
          "reasoning": { "mode": "fixed", "effort": "medium" }
        },
        {
          "match": "claude-haiku-*",
          "to": "anthropic"
        }
      ]
    }
  }
}
```

To inject a gateway-owned API key for an Anthropic upstream — instead of
forwarding the client's subscription OAuth token — add an `auth` block:

```json
{
  "upstreams": {
    "anthropic": {
      "kind": "anthropic",
      "url": "https://api.anthropic.com",
      "auth": {
        "apiKey": "env:ANTHROPIC_API_KEY"
      }
    }
  }
}
```

When `masterKey` or `auth.apiKey` uses an `env:` reference, the variable must
be present in the environment of the `makaio serve` process, not only in Claude
Code's environment.

**Starting the host with the config:**

```sh
# --config flag must precede the subcommand
makaio --config ./makaio.config.json serve

# Or via the environment variable
MAKAIO_CONFIG_FILE=./makaio.config.json makaio serve
```

**Config precedence at extension start**
(`packages/kernel/src/extension/resolve-config.ts`):

1. Stored extension-config record, written by the desktop settings UI — highest
   priority.
2. `packageConfigDefaults` in the runtime config file.
3. `descriptor.json` defaults — lowest priority.

In the headless `makaio serve` path no stored records are loaded, so
`packageConfigDefaults` in the config file is authoritative.

### Upstreams

The `upstreams` field is a named map of upstream configurations. Keys must match
`[A-Za-z0-9_-]+`. Every name referenced by `default` or by a rule's `to` field
must be defined here.

**URL field constraints:** The `url` field in each upstream entry accepts an
absolute `http:`/`https:` URL with an optional path prefix. Embedded
credentials (`user:password@`), query strings, and fragments are rejected.
Leading and trailing whitespace is stripped automatically.

#### `kind: "anthropic"`

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | `"anthropic"` | — | Selects the Anthropic upstream kind. |
| `url` | URL string | `https://api.anthropic.com` | Base URL for the Anthropic API. Override to target a compatible proxy or staging environment. |
| `auth.apiKey` | `CredentialRef` (optional) | — | When present, the gateway sets `x-api-key` to the resolved key and removes `authorization`. When omitted, the client's own credentials pass through byte-exact, preserving subscription OAuth end-to-end. |

**Auth vs. pass-through:** Without `auth`, subscription OAuth tokens flow
through the gateway unchanged — every request carries the client user's own
Anthropic credentials. With `auth`, the gateway injects a single service API
key for all requests to this upstream, replacing the client's credentials. This
is useful for API-key-based setups but does not support OAuth account rotation:
a single Anthropic API key represents one service account, and switching between
accounts at the gateway layer requires multiple named Anthropic upstreams each
with a different `auth.apiKey`, plus a strategy capable of distributing across
them (see [Strategies](#strategies)).

#### `kind: "litellm"`

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | `"litellm"` | — | Selects the LiteLLM upstream kind. |
| `url` | URL string | — | Base URL of the LiteLLM proxy, e.g. `http://127.0.0.1:4000`. The gateway appends `/v1/messages` or `/v1/messages/count_tokens` when forwarding. |
| `masterKey` | `CredentialRef` | — | LiteLLM master key, resolved by the credential service at startup. Never stored in plain text. |

**`CredentialRef` formats:**

| Format | Source |
|---|---|
| `env:VAR_NAME` | Environment variable |
| `file:/path/to/key` | File contents |
| `keychain:<service>:<account>` | OS keychain |
| `stored:providerConfig:<configId>:<key>` | Credential store |

### `default`

Name of the upstream used when no rule matches a request. Defaults to
`"anthropic"`. Must be a key present in `upstreams`. A LiteLLM upstream is
valid here when all unmatched traffic should be routed through LiteLLM.

Only upstreams referenced by `default` or a rule's `to` have their secrets
resolved; an unreferenced upstream with an unresolvable secret is never looked
up at all. See [Credential resolution and startup](#credential-resolution-and-startup).

### `accessToken`

Optional `CredentialRef`. When present, every request to the gateway must
supply the resolved plaintext value in the `x-gateway-token` header. Requests
with a missing or incorrect token receive a `401` response and are never
forwarded to an upstream. The token itself is stripped from all upstream
requests by the header filter.

Unlike upstream secrets — which are only resolved for upstreams that `default`
or a rule's `to` actually references — `accessToken` is **always resolved** when
configured, regardless of which upstreams are in use. Until it resolves, the
gateway answers `503` rather than serving traffic unauthenticated: it cannot
check a token it does not have, so it refuses instead of waving requests
through.

Set this whenever the host is reachable beyond loopback. Claude Code can supply
it via `ANTHROPIC_CUSTOM_HEADERS="x-gateway-token: <value>"`.

### `maxBodyBytes`

Maximum number of request body bytes the gateway will buffer before responding
with `413`. Defaults to `67108864` (64 MiB). Applies to both
`/v1/messages` and `/v1/messages/count_tokens`.

The gateway must hold the entire request body in memory before it can route
(the `model` field decides the upstream). This cap prevents runaway memory
growth from unusually large tool-result payloads.

When a request declares a valid `content-length` within the cap, the buffer is
allocated once at that size and filled in place, so peak memory stays at one
copy of the body. A request that then delivers more bytes than it declared
contradicts its own framing and is rejected with `400`.

### Rules

The `rules` field is an ordered list of routing rules. Rules are evaluated in
declaration order; the first match wins. Requests that match no rule are
forwarded to the upstream named by `default`. An empty list routes all requests
to the default upstream.

| Field | Type | Default | Description |
|---|---|---|---|
| `match` | string | — | Exact model identifier, or a glob where `*` is the only supported metacharacter. An empty string is rejected. |
| `to` | string \| string[] | — | Name or non-empty list of upstream names to route matching requests to. A single string routes unconditionally to that upstream. Multiple names engage the `strategy` to pick one. Every name must be defined in `upstreams`. |
| `strategy` | `StrategyConfig` | `{ kind: "static" }` | Controls which upstream is selected when `to` lists multiple candidates. See [Strategies](#strategies). |
| `model` | string (optional) | — | Upstream model name to substitute in the forwarded body. Valid only when all upstreams referenced by `to` have `kind: "litellm"`. When omitted, the requested model is preserved. |
| `reasoning` | `ReasoningMode` (optional) | — | Controls `thinking` parameter handling. Valid only when all upstreams referenced by `to` have `kind: "litellm"`. Defaults to `{ mode: "passthrough" }`. See [Reasoning modes](#reasoning-modes). |

**Rule matching:**

- Rules are evaluated in declaration order; the first match wins.
- `*` is the only glob metacharacter. All other characters are treated as
  literals. For example `gpt-*` matches `gpt-4o` and `gpt-5`, but not
  `claude-gpt`.
- An empty `rules` list sends all requests to the default upstream.

### Strategies

The `strategy` field on a rule controls which upstream is selected when `to`
lists multiple candidates.

| `kind` | Behaviour | Status |
|---|---|---|
| `static` (default) | Always selects the first upstream listed in `to`. When `to` has a single entry, equivalent to unconditional selection. | Implemented |
| `round-robin` | Distributes requests across `to` in rotation. Enables capacity spreading or account rotation when combined with multiple Anthropic upstreams each configured with a different `auth.apiKey`. | Not implemented; the `strategy` union and `TargetSelector` are the extension points. |

**Applying config changes:**

Config is read and validated at extension activation, and compiled into the
routing table on first use. Either way it is read once: changes to the config
file take effect only after the host is restarted (or the gateway extension is
disabled and re-enabled).

## Credential resolution and startup

The gateway resolves no credential while it is activating. Activation builds the
router and nothing else, so it cannot fail on a credential and the routes are
always mounted.

The credentials — every referenced upstream's secret plus
[`accessToken`](#accesstoken) — are resolved together, on first use, and the
result is kept only if the whole set resolved. A failed attempt is discarded, so
the next attempt starts over.

Two things trigger an attempt:

1. **The host's coordinator-ready barrier**, once every extension has started.
   This is the normal path and the point at which a broken reference is
   reported.
2. **An incoming request**, whenever no successful resolution is being held.
   The host accepts connections before it finishes starting, so requests can
   and do arrive first.

**While the credentials are unavailable, every path under the mount answers
`503`** with an Anthropic-shaped error body:

```json
{ "type": "error", "error": { "type": "api_error", "message": "Gateway upstream credentials are not available yet." } }
```

Each refused request writes one rejection line and publishes no
`gateway.requestRouted` event — nothing was routed. The gateway is not wedged:
the next request tries again, so it starts serving the moment the references
become resolvable.

**Why it works this way.** A `stored:` reference is resolved by a credential
service that is itself an extension, and extensions start in discovery order —
the gateway can start first. Resolving eagerly would therefore fail activation
for a configuration that is entirely correct, with nothing to retry it; the host
would come up with the gateway permanently dead. Resolving lazily turns that
into a few seconds of `503`.

**A genuinely broken reference** — a typo in an `env:` name, a deleted keychain
entry — no longer fails activation either. It surfaces as one `error` line at
the coordinator-ready barrier, naming the config site and the reference:

```
[gateway] credentials unavailable reason="Credential for upstream \"litellm\" (ref \"env:LITELM_MASTER_KEY\") could not be resolved."
```

followed by a `503` for every request until the reference resolves. Fixing what
the reference *points at* — adding the missing credential-store entry — takes
effect on the next request. Fixing the reference itself, or the process
environment it reads, still needs a restart.

## Reasoning modes

LiteLLM's parameter guard rejects `reasoning_effort` for backends that do not
declare it in their Azure allow-list (verified 2026-09-17 against an Azure
Foundry `DeepSeek-V4-Flash-0731` deployment). The `reasoning` field injects
LiteLLM control fields into the outgoing body to work around this without
requiring changes to the LiteLLM configuration.

| Mode | Config shape | Effect on the outgoing body |
|---|---|---|
| `passthrough` | `{ mode: "passthrough" }` | Adds `allowed_openai_params: ["reasoning_effort"]`; forwards `thinking` as sent by Claude Code. Use for models that support thinking natively. |
| `drop` | `{ mode: "drop" }` | Removes `thinking` and `output_config.effort` from the outgoing body (removes `output_config` entirely when only `effort` was present), then sets `drop_params: true`. Use when the upstream model does not support thinking. |
| `fixed` | `{ mode: "fixed", effort: "low" \| "medium" \| "high" }` | Replaces `thinking` with `{ type: "enabled", budget_tokens }` — `low` → 1024, `medium` → 2048, `high` → 4096 — and adds `allowed_openai_params`. Use when Claude Code sends `thinking: { type: "adaptive" }` but the upstream requires an explicit token budget. |

`passthrough` is the default when `reasoning` is omitted from a LiteLLM-targeted rule.

## Claude Code setup

Set a single environment variable so Claude Code directs all Anthropic Messages
traffic through the gateway:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:6252/gateway
```

The host server listens on `127.0.0.1` port `6252` by default.

**Selecting models:**

Pass any model identifier through `--model` or the `/model` slash command.
Claude Code sends the string to the gateway verbatim without validation.

To add a gateway-routed model to Claude Code's `/model` picker, set:

```sh
export ANTHROPIC_CUSTOM_MODEL_OPTION=DeepSeek-V4-Flash-0731
```

**Subscription OAuth:**

Keep your existing Claude subscription login as is. The gateway forwards the
`Authorization` bearer token and all `anthropic-beta` values to Anthropic
upstreams configured without `auth`, preserving subscription OAuth end-to-end.
No additional authentication setup is required for the pass-through case.

**Slow models:**

Some non-Anthropic backends spend a long time in a "thinking" phase without
emitting bytes. Claude Code aborts a stream after 300 seconds of silence. If
you hit this with a slow model, set:

```sh
export API_FORCE_IDLE_TIMEOUT=0
```

## Logging

The gateway writes **exactly one line to the server console per request** — the
one it routed, and the one it turned away. Logging is always on; there is no
level to configure and no option to set. The lines go to `console.info` for a
request the upstream answered with a 2xx, and to `console.warn` for everything
else, so an operator can spot failures without reading every line.

One line is not about a request: `console.error` reports credentials the gateway
could not resolve once the host finished starting — see
[Credential resolution and startup](#credential-resolution-and-startup). It is
written once per failed attempt, not once per request.

### Routed requests

```
[gateway] POST /v1/messages model="claude-sonnet-4-5" upstream="anthropic" kind=anthropic rule=default outcome=completed status=200 streamed=true duration=2ms
```

| Field | Meaning |
|---|---|
| `model` | Model the client asked for. |
| `upstream` / `kind` | Name of the upstream that handled it, and whether it is an `anthropic` or `litellm` target. |
| `upstreamModel` | Model actually sent upstream. Shown **only** when a rule renamed it. |
| `rule` | Zero-based index of the matching rule, or `default` when none matched. |
| `outcome` / `status` | `completed` with the upstream status, or `aborted` / `upstream-unreachable` with `status=-`. |
| `streamed` | Whether the client asked for `stream: true`. |
| `duration` | Milliseconds from the buffered request body to the upstream response headers. |

A rule that renames the model adds `upstreamModel`:

```
[gateway] POST /v1/messages model="deepseek-r1" upstream="litellm" kind=litellm upstreamModel="DeepSeek-V4-Flash" rule=0 outcome=completed status=200 streamed=true duration=2ms
```

### Upstream errors

When the upstream answers with 4xx or 5xx, the line carries a summary of the
upstream's error body, which is usually where the actual explanation is. The
body is **never quoted raw**: only the `type` and `message` fields of a
recognised error envelope (`{"error": {"type", "message"}}`, as used by both the
Anthropic and the OpenAI/LiteLLM error formats) are extracted.

```
[gateway] POST /v1/messages model="claude-nope" upstream="anthropic" kind=anthropic rule=default outcome=completed status=404 streamed=false duration=2ms upstreamError="not_found_error: model not found: claude-nope"
```

A body that is not a recognised envelope — HTML from a reverse proxy, a
truncated payload, an empty body — is described rather than quoted:

```
[gateway] POST /v1/messages model="claude-x" upstream="anthropic" kind=anthropic rule=default outcome=completed status=502 streamed=false duration=2ms upstreamErrorBytes=37 upstreamContentType="text/html"
```

`upstreamErrorBytes` is suffixed with `+` when the read was cut short — the
4 KiB the gateway is willing to read was reached, or the read was aborted
because the request ended — so the count is a floor, not the body's size.

> **Treat gateway logs as sensitive operator output.** `upstreamError` carries
> the upstream's own error *message*, and some upstreams quote a fragment of the
> offending request back in it (a model name, a parameter, a field path). The
> gateway logs nothing outside those two envelope fields, but it cannot control
> what an upstream chooses to put inside them.

The body is read from a clone of the response, off the response path: the client
receives its headers and its original, unbuffered, byte-for-byte body stream
immediately, and only the log line waits for the read. The read is bounded by
4 KiB and by the request's own lifetime, so a slow or endless error body delays
nothing and outlives nothing.

### Rejected requests

A request rejected before a routing decision exists publishes no
`gateway.requestRouted` event, but it is still logged — "nothing arrived" and
"everything was rejected" must not look the same in the server output.

```
[gateway] POST /gateway/v1/messages rejected status=503 reason="credentials unavailable"
[gateway] POST /gateway/v1/messages rejected status=503 reason="gateway shutting down"
[gateway] POST /gateway/v1/messages rejected status=401 reason="access token missing"
[gateway] POST /gateway/v1/messages rejected status=401 reason="access token invalid"
[gateway] POST /v1/messages rejected status=413 reason="Request body exceeds the configured maximum of 256 bytes." bytes=900 limit=256
[gateway] POST /v1/messages rejected status=400 reason="Request body is not valid JSON."
[gateway] POST /gateway/v1/complete rejected status=404 reason="unknown route"
```

A `503` line reports only that the gateway is not serving; *why* the credentials
are unavailable is in the `error` line written at the coordinator-ready barrier,
so the cause appears once instead of on every request. The second `503` reason
is not a fault at all: a request that arrives while the host is shutting down,
or after the extension was disabled, is turned away as `gateway shutting down`
so it is never mistaken for a configuration problem.

`bytes` on a 413 is the declared `content-length` when the request was turned
away before any bytes were buffered, otherwise the running total at the moment
the cap was passed — compare it against `limit` to decide whether
[`maxBodyBytes`](#maxbodybytes) is set too low.

A request that fails in no anticipated way is logged too, so nothing can leave
the gateway unaccounted for: `status=499 reason="client disconnected"` when the
client vanished mid-upload, `status=500 reason="internal error"` otherwise. It
is the one rejection line that can be written after routing began, and it
reports the routed endpoint path (`/v1/messages`) like a routed line does. The
reason is a fixed string — never the underlying error message, which can quote
a fragment of the body that was being read.

A rejection line carries no model: every rejection happens at or before body
parsing, so no model has been read yet. The 503, 401, and 404 lines report the
full request path, because the gate and the catch-all both run ahead of route
matching and fire on paths the gateway does not serve.

### What is never logged

- Request or response headers of any kind.
- `authorization`, `x-api-key`, or `x-gateway-token` values — a 401 line says
  whether the token was missing or wrong, never what was sent or expected.
- The configured access token and the LiteLLM master key.
- Request bodies and message content.
- Upstream response bodies, including error bodies. Only the two allowlisted
  envelope fields are extracted; anything else an upstream puts in an error
  body — echoed headers, echoed messages — is discarded unread.

Every free-form value is flattened to a single line before it is written, so
neither a model identifier nor an upstream message can inject extra output or a
terminal escape sequence, and each is length-capped so neither can produce an
unbounded line.

### Sending the lines elsewhere

`createGatewayRouter` accepts an optional `logger` implementing the three-method
`GatewayLogger` interface (`info(message)`, `warn(message)`, `error(message)`).
Supply one to route the lines into a host-owned sink; omit it for the console
default. A sink that throws — or that returns a rejecting promise despite the
`void` signature — cannot affect the proxied response: every write is guarded.

## Observability

The gateway publishes one bus event per routed request on the `gateway`
namespace:

**Subject:** `gateway.requestRouted`

**Payload fields:**

| Field | Type | Description |
|---|---|---|
| `upstream` | string | Name of the upstream that handled the request, as declared in the `upstreams` config map (e.g. `"anthropic"`, `"litellm"`). Useful for telemetry when multiple named upstreams of the same kind exist. |
| `target` | `"anthropic"` \| `"litellm"` | Upstream kind selected. |
| `path` | `"/v1/messages"` \| `"/v1/messages/count_tokens"` | Requested endpoint path. |
| `requestedModel` | string | Model identifier from the incoming request body. |
| `upstreamModel` | string | Model identifier forwarded to the upstream. Equals `requestedModel` when no model substitution was applied. |
| `outcome` | `"completed"` \| `"aborted"` \| `"upstream-unreachable"` | Request outcome. |
| `status` | number \| null | HTTP status code from the upstream (100–599), or `null` when `outcome` is not `"completed"`. |
| `durationMs` | number | Wall-clock milliseconds from receiving the request body to the first byte of upstream response headers. |
| `streamed` | boolean | Whether the upstream response was streamed as Server-Sent Events (`stream: true` in the request body). |
| `ruleIndex` | number \| null | Zero-based index of the matching rule, or `null` when the request used the default upstream (no rule matched). Present on both the `anthropic` and `litellm` target variants. |

Subscribe on the bus to collect routing telemetry from any extension or service
without coupling to the gateway implementation.

A request rejected before a routing decision exists (401, 413, 400, 404)
publishes no event. Those rejections are visible in the console output instead — see
[Logging](#logging).

## Limitations

- **`count_tokens` with subscription OAuth** — Anthropic rejects `count_tokens`
  requests authenticated with OAuth ("jwt auth is not yet supported"). Claude
  Code detects the failure and falls back to token estimation. The gateway
  forwards the request and the error verbatim; no special handling is applied.

- **300-second byte watchdog** — Claude Code aborts a stream if the upstream
  emits no bytes for 300 seconds. Long silent "thinking" phases on non-Anthropic
  models can trigger this. It is not a gateway defect; set
  `API_FORCE_IDLE_TIMEOUT=0` in Claude Code's environment if needed.

- **No `/v1/models` aggregation** — The gateway does not expose or aggregate
  model lists. The `/v1/models` endpoint (opt-in in Claude Code) is not served
  under `/gateway`; any request to an unrecognised path returns 404.

- **Routes are unauthenticated by default** — The host binds to loopback
  (`127.0.0.1`) by default, but `makaio serve --lan-bind` or a non-loopback
  `--host` exposes routes to the network. Routes carry no built-in
  authentication. Configure `accessToken` (a `CredentialRef`; clients send
  `x-gateway-token`; Claude Code via
  `ANTHROPIC_CUSTOM_HEADERS="x-gateway-token: <value>"`) whenever the host is
  reachable beyond loopback. Any process that can reach the server can issue
  forwarded requests using the configured credentials.

- **Request body size** — `maxBodyBytes` (default 64 MiB) caps the incoming
  request body; requests that exceed this limit receive a `413` response.

- **Config changes require a restart** — The gateway reads its rule list at
  extension activation and compiles it once. Changes to `packageConfigDefaults`
  (or the stored extension config record) take effect only after the gateway
  extension is disabled and re-enabled, or the host is restarted. A credential a
  reference *points at* can change without a restart — only the reference itself
  is fixed at activation.

- **Electron development mode** — The desktop application in development mode
  does not expose extension HTTP routes. Use `makaio serve` for local testing.

- **Credential resolution is host-provided** — `env:`, `file:`, and `keychain:`
  references are resolved locally on every host. `stored:` references require a
  host with a credential service registered; on hosts without one (bare headless
  `makaio serve`) they resolve to `null`, and the gateway answers `503` to every
  request instead of forwarding with a credential it does not have. It activates
  and stays mounted either way — see
  [Credential resolution and startup](#credential-resolution-and-startup).

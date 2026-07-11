---
'@makaio/contracts': minor
'@makaio/framework': minor
'@makaio/ai-adapters-core': minor
'@makaio/extension-account-manager': minor
'@makaio/adapter-anthropic-sdk': minor
'@makaio/adapter-claude-agent-sdk': minor
'@makaio/adapter-claude-code-cli': minor
'@makaio/adapter-claude-code-tmux': minor
'@makaio/adapter-codex-app-server': minor
'@makaio/adapter-cursor-sdk': minor
'@makaio/adapter-gemini-sdk': minor
'@makaio/adapter-github-copilot-sdk': minor
'@makaio/adapter-openai-node': minor
'@makaio/adapter-pi-sdk': minor
'@makaio/adapter-qwen-acp': minor
'@makaio/client-claude-code': minor
'@makaio/client-codex': minor
'@makaio/client-cursor': minor
'@makaio/client-gemini': minor
'@makaio/client-github-copilot': minor
'@makaio/client-qwen': minor
'@makaio/provider-alibaba': minor
'@makaio/provider-anthropic': minor
'@makaio/provider-cursor': minor
'@makaio/provider-github-copilot': minor
'@makaio/provider-google': minor
'@makaio/provider-kimi': minor
'@makaio/provider-nanogpt': minor
'@makaio/provider-openai': minor
'@makaio/provider-openai-codex': minor
'@makaio/provider-opencode-go': minor
'@makaio/provider-openrouter': minor
'@makaio/provider-qwen-acp': minor
'@makaio/provider-z-ai': minor
---

Normalize adapter authentication around explicit, inferred, and unauthenticated method declarations.

This is a deliberate platform-contract cutover: provider config files now use v2 with one explicit
auth selection; v1 files, sentinel configs, top-level credentials, `sourceRef`, and
`credentialEnvVars` are removed rather than inferred. Adapters declare how an auth method is
delivered, so explicit API keys and OAuth tokens remain supported while native Claude and Codex
authentication is isolated, portable only for local execution, and never sourced from ambient
environment variables.

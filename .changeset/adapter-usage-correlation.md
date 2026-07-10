---
"@makaio/framework": minor
"@makaio/adapter-claude-agent-sdk": patch
"@makaio/adapter-claude-code-cli": patch
"@makaio/adapter-claude-code-tmux": patch
---

Attribute normalized adapter usage to the active workflow execution and frame without inventing provider call identities. Preserve genuine Claude terminal usage during bounded abort drains, terminalize interrupted turns when no result arrives, and stop assigning cumulative Claude Code session cost to latest-request Tmux usage.

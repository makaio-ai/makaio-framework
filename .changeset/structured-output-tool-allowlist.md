---
'@makaio/adapter-claude-agent-sdk': patch
---

Allow Claude Code's synthetic `StructuredOutput` tool under caller tool lists when the query requests structured output (`responseSchema`). The CLI implements `outputFormat: { type: 'json_schema' }` as a tool with that name, which a Makaio-named allowlist cannot list, so the adapter's PreToolUse hook and `canUseTool` denied the call and the structured result never arrived (FACT-253). The query's effective tool policy now admits exactly that tool name when a schema is set; every other call is checked as before, and without a schema `StructuredOutput` stays denied under a restricting allowlist.

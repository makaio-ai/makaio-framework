---
'@makaio/adapter-claude-agent-sdk': patch
---

Allow Claude Code's synthetic `StructuredOutput` tool under caller tool lists when the query requests structured output (`responseSchema`). The CLI implements `outputFormat: { type: 'json_schema' }` as a tool with that name, which a Makaio-named allowlist cannot list, so the adapter's PreToolUse hook denied the call and the structured result never arrived (FACT-253). The bundled CLI (SDK 0.2.131) runs the tool's own permission check (`allow`) before `canUseTool`, so only the hook blocked in practice; admitting it in `canUseTool` too is defence in depth, and the central tool approval service is not reached for this tool. The query's effective tool policy now admits exactly that tool name when a schema is set; every other call is checked as before, and without a schema `StructuredOutput` stays denied under a restricting allowlist.

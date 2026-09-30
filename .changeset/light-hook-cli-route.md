---
"@makaio/cli": patch
"@makaio/electrobun": patch
"@makaio/electron": patch
"@makaio/extension-client-hooks": patch
"@makaio/adapter-cursor-sdk": patch
---

Route `makaio hook received|handle` through a light fast path: the CLI entries detect the exact hook argv shapes before loading the full command graph, connect with a short-lived bus client, and run the same hook runners. If the bus is not reachable, the invocation falls back to the full CLI before stdin is read, so health probing, desktop auto-launch and the `--debounce-failure` cool-down behave as before. The Electrobun CLI bundle is built with code splitting (`dist/cli-chunks/`) so the light path loads only its own modules. The client-hook runner is exported as `@makaio/extension-client-hooks/hook-runner`, and the cursor-sdk adapter imports its hook subjects from the light `hook-subjects` subpath.

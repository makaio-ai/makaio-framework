---
"@makaio/framework": patch
"@makaio/adapter-codex-app-server": patch
---

A throwing `onDisconnected` observer no longer escapes the end handlers of `StdioServerTransport` and `StdioClientTransport`, and a throw from the codex app-server connector's generation-end handling no longer escapes its end continuation. Each is isolated and logged instead of becoming an unhandled rejection or an uncaught exception that can terminate the host. `@makaio/subprocess` exports `notifyObserver`, which isolates one observer with the same contract as the listener dispatch of its transports.

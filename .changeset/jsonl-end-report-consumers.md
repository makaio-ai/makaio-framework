---
"@makaio/framework": major
"@makaio/adapter-codex-app-server": patch
---

The JSON-RPC client and `StdioServerTransport` are now driven by the JSONL transport's end report (`ended`), and the transitional error channel is gone.

`createJsonRpcClient` settles its outstanding requests on every end of its channel, whatever the cause. A stop that someone else requested on the channel, which used to leave pending requests waiting until their timeout (or forever with timeout `0`), now rejects them as well. The rejection names the end by codes and signals only, for example `JSON-RPC transport ended unexpectedly: exited with code 3` or `JSON-RPC transport stopped on request: exited with signal SIGTERM`, and it comes after the channel delivered its last message, so a response written just before the end still resolves its request. `close()` on the client still rejects pending requests at once with `JSON-RPC client closed`; it no longer closes a channel that has already ended. A request issued while the channel no longer accepts writes still rejects at once.

`StdioServerTransport` sessions end through the end report. The new `stopTiming` option bounds the end of a session (kill grace, exit observation, drain), so `disconnect()` takes at most about their sum, and a `disconnect()` whose end may have left a process running (an unobserved exit, a held pipe, an unproven process group) is logged. An end the host did not ask for (an exit, also with code 0, a failed spawn, a failed channel, or stdout ending while the child keeps running) makes the session terminal and calls `onDisconnected` once; `disconnect()` is a requested end, never an error. The session uses `finalLine: 'parse'`, so an unterminated final line is delivered at the genuine end of stdout when it passes the bus message shape check, and discarded otherwise. The new `terminateTree` option (default `true`) controls whether ending a session stops the child's whole process tree. Inbound messages are handed to every receive handler synchronously, as the JSONL transport delivers them, so a message the child wrote before it exited reaches every handler before the session ends, also behind a slow handler; handlers no longer wait for one another. While a session drains after its child exited, `subscribe()` and `unsubscribe()` only buffer the change instead of rejecting; `send()` still rejects.

`createJsonRpcClient` hands a notification to exactly the handlers registered when it arrived, like every other listener path of the package: a handler that subscribes, unsubscribes or closes the client during dispatch changes nothing for the message already in dispatch.

The codex app-server connector creates each generation's JSON-RPC client before it evaluates that generation's end, so in-flight requests are rejected with the end's description before a terminal error closes the client.

**Breaking:**

- `IJsonlTransport.onError` and the `ErrorListener` type are removed. Consumers read `ended` and decide from `end.cause` what an end means; `describeTransportEnd(end)` gives the content-free description the error messages used to carry.
- `JsonlChannel` is now `Pick<IJsonlTransport, 'send' | 'close' | 'onMessage' | 'ended'>`: a channel driven by `createJsonRpcClient` must provide the end report, and its `close()` returns it.
- JSON-RPC rejections caused by the channel's end start with `JSON-RPC transport` instead of the child's process name.
- `StdioServerTransport.disconnect()` resolves only once the session's end was reported (bounded by the JSONL transport's stop escalation and drain), instead of right after asking the child to stop.
- `notifyListeners` is no longer exported from `@makaio/subprocess`.
- Together with the codex app-server changes, this replaces the error-channel contract of the earlier malformed-line change: `IJsonlTransport.onError`, `ErrorListener`, the exported `notifyListeners`, the owner callback of `createJsonRpcClient(transport, onTransportFailure)` and the multi-subscriber codex `StdioTransport` no longer exist. A session's `send()` rejects with `StdioServerTransport: not connected` once its JSONL transport stops accepting writes.

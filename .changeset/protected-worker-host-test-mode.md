---
'@makaio/framework': minor
'@makaio/runtime-node': minor
'@makaio/runtime-bun': minor
---

Add an internal worker exchange test seam for the normal Node and Bun host boot paths. The option defaults off and requires a loopback listener. It is intended for local tests and carries no production support or stability guarantee. When enabled, the boot-owned dispatch supplies the protected exchange after storage and host rights are ready. Ordinary connections keep their loopback receive context when the host omits explicit authentication. Bun test hosts use the internal `serveBunWorkerExchangeTest` helper to install the exchange-capable fetch and WebSocket handlers before boot.

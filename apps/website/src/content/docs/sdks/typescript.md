---
title: TypeScript SDK
description: TypeScript SDK for the Makaio bus protocol.
---

The TypeScript SDK (`@makaio/sdk`) re-exports the framework's own bus-core types and transport
layer, providing a thin convenience wrapper for TypeScript consumers.

## Installation

```bash
yarn add @makaio/sdk
```

## Features

- Full type safety with the framework's bus subject types
- WebSocket transport with automatic reconnection
- Direct re-export of `@makaio/bus-core` and `@makaio/contracts`
- Zero overhead — uses the same code the framework runs internally

## Quick Start

```typescript
import { AgentSubjects, BusClient } from '@makaio/sdk';

const bus = new BusClient('ws://localhost:6252/bus');
await bus.connect();
await bus.emit(AgentSubjects.message, {
  agentId: 'agent-1',
  adapterId: 'adapter-1',
  adapterName: 'example',
  adapterSessionId: 'adapter-session-1',
  content: 'hello',
});
bus.close();
```

For full API details, see the [SDK source](https://github.com/makaio-ai/makaio-framework/tree/main/sdks/typescript).

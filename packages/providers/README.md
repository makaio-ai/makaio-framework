# @makaio/providers

Provider implementations for platform-specific capabilities.

## What This Is

Foundation for building cross-platform providers that handle environment-specific concerns. Provides:

- `ConfigProvider` - Abstract config loading with env overrides, validation, and merge logic
- `IWebhookProvider` - Interface for platform webhook handling (GitHub, GitLab, etc.)

## Quick Start

This is a private workspace package. Add it to a consuming workspace package with the workspace
protocol:

```json
{
  "dependencies": {
    "@makaio/providers": "workspace:*"
  }
}
```

**Create a Node.js config provider:**

```typescript
import { ConfigProvider } from '@makaio/providers';
import type { Config } from '@makaio/contracts';
import type { IConfigStorage } from '@makaio/core';

class NodeConfigProvider extends ConfigProvider {
  constructor(storage: IConfigStorage<Config>) {
    super(storage);
  }

  async getMachineId(): Promise<string> {
    // Read from persistent machine identity storage or generate UUID
    return readOrCreateMachineId();
  }

  protected getEnv(key: string): string | undefined {
    return process.env[key];
  }
}
```

**Use the config provider:**

```typescript
const provider = new NodeConfigProvider(storage);

// Get config with merge: defaults < stored < env < overrides
const config = await provider.getConfig({ mode: 'remote' });

// Save validated config
await provider.saveConfig(config);
```

**Implement a webhook provider:**

```typescript
import type { IWebhookProvider, WebhookEvent } from '@makaio/providers';

const githubProvider: IWebhookProvider = {
  capabilities: {
    platform: 'github',
    supportedEvents: ['push', 'pull_request', 'issues'],
  },

  async verifySignature(payload, signature) {
    return verifyGitHubSignature(payload, signature, secret);
  },

  async parseWebhook(payload): Promise<WebhookEvent> {
    return {
      platform: 'github',
      event: payload.event,
      action: payload.action,
      data: payload,
    };
  },

  registerHandlers(bus) {
    // Register bus handlers for webhook events
  },
};
```

## Architecture Principles

**1. Abstract Platform Concerns** - Base classes handle common logic, subclasses implement platform-specific details
**2. Merge-Based Config** - Layered config (defaults < stored < env < overrides) with validation
**3. Provider Interfaces** - Clean contracts for webhook handling across platforms
**4. Validation First** - All config goes through Zod schema validation

## Key Exports

**Classes:**
- `ConfigProvider` - Abstract config provider with env overrides and validation

**Interfaces:**
- `IWebhookProvider` - Webhook handling contract

**Types:**
- `WebhookEvent` - Normalized webhook event structure

## Design Philosophy

**"Platform abstraction through extension"** - Common patterns in base implementations, platform specifics in subclasses.

---

*Part of Makaio Framework*

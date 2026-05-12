import { describe, expect, it } from 'vitest';
import { buildEntityGraph } from './entity-graph';

describe('buildEntityGraph', () => {
  const graph = buildEntityGraph();

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  it('discovers all clients', () => {
    const ids = graph.clients.map((c) => c.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('gemini');
    expect(ids).toContain('codex');
    expect(ids).toContain('qwen');
    expect(ids).toContain('github-copilot');
    expect(ids).toHaveLength(5);
  });

  it('discovers all adapters', () => {
    const names = graph.adapters.map((a) => a.name);
    expect(names).toContain('anthropic-sdk');
    expect(names).toContain('openai-node');
    expect(names).toContain('claude-code-cli');
    expect(names).toContain('claude-code');
    expect(names).toContain('codex-app-server');
    expect(names).toContain('gemini-sdk');
    expect(names).toContain('github-copilot-sdk');
    expect(names).toContain('pi-sdk');
    expect(names).toContain('qwen-acp');
    expect(names).toHaveLength(9);
  });

  it('discovers all providers', () => {
    const ids = graph.providers.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('anthropic-oauth');
    expect(ids).toContain('openai');
    expect(ids).toContain('openai-codex');
    expect(ids).toContain('google');
    expect(ids).toContain('google-oauth');
    expect(ids).toContain('github-copilot');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('nanogpt');
    expect(ids).toContain('kimi');
    expect(ids).toContain('z-ai');
    expect(ids).toContain('alibaba');
    expect(ids).toContain('opencode-go');
    expect(ids).toContain('opencode-go-anthropic');
    expect(ids).toContain('qwen-oauth');
  });

  // -------------------------------------------------------------------------
  // Protocol compatibility (Adapter ↔ Provider)
  // -------------------------------------------------------------------------

  it('matches anthropic-sdk to anthropic-protocol providers', () => {
    const providers = graph.adapterToProviders.get('anthropic-sdk');
    expect(providers).toBeDefined();
    const ids = providers!.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('kimi');
    expect(ids).toContain('z-ai');
    expect(ids).toContain('alibaba');
    expect(ids).toContain('opencode-go-anthropic');
    // anthropic-oauth requires claude-code client, anthropic-sdk has no clients → excluded
    expect(ids).not.toContain('anthropic-oauth');
  });

  it('matches openai-node to openai-protocol providers without requiredClient', () => {
    const providers = graph.adapterToProviders.get('openai-node');
    expect(providers).toBeDefined();
    const ids = providers!.map((p) => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('nanogpt');
    expect(ids).toContain('z-ai');
    expect(ids).toContain('alibaba');
    expect(ids).toContain('opencode-go');
    // requiredClient providers excluded from generic openai-node
    expect(ids).not.toContain('openai-codex');
    expect(ids).not.toContain('github-copilot');
    expect(ids).not.toContain('google');
    expect(ids).not.toContain('google-oauth');
    expect(ids).not.toContain('qwen-oauth');
  });

  it('matches claude-code-cli to anthropic providers reachable via claude-code client', () => {
    const providers = graph.adapterToProviders.get('claude-code-cli');
    expect(providers).toBeDefined();
    const ids = providers!.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('anthropic-oauth');
    expect(ids).toContain('kimi');
  });

  it('matches codex-app-server to openai-codex (requiredClient = codex)', () => {
    const providers = graph.adapterToProviders.get('codex-app-server');
    expect(providers).toBeDefined();
    const ids = providers!.map((p) => p.id);
    expect(ids).toContain('openai-codex');
    expect(ids).toContain('openai');
    expect(ids).toContain('openrouter');
  });

  it('matches gemini-sdk to google providers (requiredClient = gemini)', () => {
    const providers = graph.adapterToProviders.get('gemini-sdk');
    expect(providers).toBeDefined();
    const ids = providers!.map((p) => p.id);
    expect(ids).toContain('google');
    expect(ids).toContain('google-oauth');
    expect(ids).toContain('openai');
  });

  it('matches pi-sdk to both anthropic and openai providers (dual-protocol)', () => {
    const providers = graph.adapterToProviders.get('pi-sdk');
    expect(providers).toBeDefined();
    const ids = providers!.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('z-ai');
    // pi-sdk has no clients, so requiredClient providers excluded
    expect(ids).not.toContain('anthropic-oauth');
    expect(ids).not.toContain('openai-codex');
  });

  // -------------------------------------------------------------------------
  // Reverse: Provider → Adapters
  // -------------------------------------------------------------------------

  it('finds adapters for openai provider', () => {
    const adapters = graph.providerToAdapters.get('openai');
    expect(adapters).toBeDefined();
    const names = adapters!.map((a) => a.name);
    expect(names).toContain('openai-node');
    expect(names).toContain('codex-app-server');
    expect(names).toContain('gemini-sdk');
    expect(names).toContain('github-copilot-sdk');
    expect(names).toContain('pi-sdk');
    expect(names).toContain('qwen-acp');
  });

  // -------------------------------------------------------------------------
  // Client ↔ Adapter
  // -------------------------------------------------------------------------

  it('maps claude-code client to its adapters', () => {
    const adapters = graph.clientToAdapters.get('claude-code');
    expect(adapters).toBeDefined();
    const names = adapters!.map((a) => a.name);
    expect(names).toContain('claude-code-cli');
    expect(names).toContain('claude-code');
  });

  it('maps codex client to codex-app-server adapter', () => {
    const adapters = graph.clientToAdapters.get('codex');
    expect(adapters).toBeDefined();
    expect(adapters!.map((a) => a.name)).toContain('codex-app-server');
  });

  // -------------------------------------------------------------------------
  // Client ↔ Provider (transitive)
  // -------------------------------------------------------------------------

  it('makes anthropic-oauth reachable from claude-code client', () => {
    const providers = graph.clientToProviders.get('claude-code');
    expect(providers).toBeDefined();
    const ids = providers!.map((p) => p.id);
    expect(ids).toContain('anthropic-oauth');
    expect(ids).toContain('anthropic');
  });

  it('makes openai-codex reachable from codex client', () => {
    const providers = graph.clientToProviders.get('codex');
    expect(providers).toBeDefined();
    expect(providers!.map((p) => p.id)).toContain('openai-codex');
  });

  it('makes google/google-oauth reachable from gemini client', () => {
    const providers = graph.clientToProviders.get('gemini');
    expect(providers).toBeDefined();
    const ids = providers!.map((p) => p.id);
    expect(ids).toContain('google');
    expect(ids).toContain('google-oauth');
  });

  // -------------------------------------------------------------------------
  // Generic adapters expose providers to all clients
  // -------------------------------------------------------------------------

  it('makes openai reachable from all clients via openai-node (generic adapter)', () => {
    for (const client of graph.clients) {
      const providers = graph.clientToProviders.get(client.id);
      expect(providers, `${client.id} should reach providers`).toBeDefined();
      expect(
        providers!.map((p) => p.id),
        `${client.id} should reach openai`,
      ).toContain('openai');
    }
  });

  it('makes anthropic reachable from all clients via anthropic-sdk (generic adapter)', () => {
    for (const client of graph.clients) {
      const providers = graph.clientToProviders.get(client.id);
      expect(providers, `${client.id} should reach providers`).toBeDefined();
      expect(
        providers!.map((p) => p.id),
        `${client.id} should reach anthropic`,
      ).toContain('anthropic');
    }
  });

  // -------------------------------------------------------------------------
  // Reverse: Provider → Clients
  // -------------------------------------------------------------------------

  it('finds clients for anthropic-oauth (requiredClient = claude-code)', () => {
    const clients = graph.providerToClients.get('anthropic-oauth');
    expect(clients).toBeDefined();
    expect(clients!.map((c) => c.id)).toContain('claude-code');
  });

  it('finds all clients for openai (no requiredClient, via generic adapter)', () => {
    const clients = graph.providerToClients.get('openai');
    expect(clients).toBeDefined();
    expect(clients!.length).toBe(graph.clients.length);
  });
});

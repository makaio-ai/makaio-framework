import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseExtensionDescriptor } from '@makaio/contracts';
import { GatewayNamespace, GatewaySubjects, RequestRoutedEventSchema } from '../contracts/index.js';
import { gatewayExtension } from '../index.js';

// ---------------------------------------------------------------------------
// Shared valid event fixtures
// ---------------------------------------------------------------------------

const ANTHROPIC_COMPLETED_EVENT = {
  upstream: 'anthropic',
  path: '/v1/messages' as const,
  requestedModel: 'claude-opus-4-5',
  upstreamModel: 'claude-opus-4-5',
  target: 'anthropic' as const,
  ruleIndex: null,
  outcome: 'completed' as const,
  status: 200,
  durationMs: 120,
  streamed: true,
};

describe('gateway contracts', () => {
  it('namespace domain is "gateway"', () => {
    expect(GatewayNamespace.domain).toBe('gateway');
  });

  it('exposes a requestRouted subject', () => {
    expect(GatewaySubjects.requestRouted.subject).toBe('requestRouted');
  });

  it('descriptor name is "gateway"', () => {
    const descriptor = parseExtensionDescriptor(
      JSON.parse(readFileSync(new URL('../../descriptor.json', import.meta.url), 'utf-8')),
    );
    expect(descriptor.name).toBe('gateway');
    expect(descriptor.entrypoints?.server).toBe('index');
    expect(descriptor.execution).toBe('embedded');
  });

  it('declares surface "any" in both the descriptor and the manifest', () => {
    const descriptor = parseExtensionDescriptor(
      JSON.parse(readFileSync(new URL('../../descriptor.json', import.meta.url), 'utf-8')),
    );
    // The runtime matches `surface` exactly against the surface the host
    // declares itself to be ('headless' for the CLI server, 'interactive' for
    // the desktop hosts), so any concrete value would exclude the gateway from
    // every other host. The two declarations must not drift apart.
    expect(descriptor.surface).toBe('any');
    expect(gatewayExtension.surface).toBe('any');
  });

  it('RequestRoutedEventSchema accepts a valid anthropic completed event', () => {
    const event = RequestRoutedEventSchema.parse(ANTHROPIC_COMPLETED_EVENT);

    expect(event.path).toBe('/v1/messages');
    expect(event.upstream).toBe('anthropic');
    expect(event.ruleIndex).toBeNull();
    expect(event.streamed).toBe(true);
    expect(event.outcome).toBe('completed');
    expect(event.status).toBe(200);
  });

  it('RequestRoutedEventSchema accepts count_tokens path with litellm target', () => {
    const event = RequestRoutedEventSchema.parse({
      upstream: 'litellm',
      path: '/v1/messages/count_tokens',
      requestedModel: 'deepseek-v3',
      upstreamModel: 'DeepSeek-V4-Flash-0731',
      target: 'litellm',
      ruleIndex: 1,
      outcome: 'completed',
      status: 200,
      durationMs: 45,
      streamed: false,
    });

    expect(event.path).toBe('/v1/messages/count_tokens');
    expect(event.upstream).toBe('litellm');
    expect(event.ruleIndex).toBe(1);
    expect(event.target).toBe('litellm');
  });

  it('RequestRoutedEventSchema accepts aborted outcome with null status', () => {
    const event = RequestRoutedEventSchema.parse({
      ...ANTHROPIC_COMPLETED_EVENT,
      outcome: 'aborted',
      status: null,
      streamed: false,
    });

    expect(event.outcome).toBe('aborted');
    expect(event.status).toBeNull();
  });

  it('RequestRoutedEventSchema accepts upstream-unreachable outcome with null status', () => {
    const event = RequestRoutedEventSchema.parse({
      ...ANTHROPIC_COMPLETED_EVENT,
      outcome: 'upstream-unreachable',
      status: null,
    });

    expect(event.outcome).toBe('upstream-unreachable');
    expect(event.status).toBeNull();
  });

  it('RequestRoutedEventSchema accepts litellm event with null ruleIndex (default route)', () => {
    const event = RequestRoutedEventSchema.parse({
      upstream: 'litellm',
      path: '/v1/messages',
      requestedModel: 'some-model',
      upstreamModel: 'some-model',
      target: 'litellm',
      ruleIndex: null,
      outcome: 'completed',
      status: 200,
      durationMs: 50,
      streamed: false,
    });

    expect(event.target).toBe('litellm');
    expect(event.ruleIndex).toBeNull();
  });

  it('RequestRoutedEventSchema rejects completed outcome with null status', () => {
    expect(() =>
      RequestRoutedEventSchema.parse({
        ...ANTHROPIC_COMPLETED_EVENT,
        outcome: 'completed',
        status: null,
      }),
    ).toThrow();
  });

  it('RequestRoutedEventSchema rejects aborted outcome with non-null status', () => {
    expect(() =>
      RequestRoutedEventSchema.parse({
        ...ANTHROPIC_COMPLETED_EVENT,
        outcome: 'aborted',
        status: 200,
      }),
    ).toThrow();
  });

  it('RequestRoutedEventSchema rejects an extra key (strict)', () => {
    expect(() =>
      RequestRoutedEventSchema.parse({
        ...ANTHROPIC_COMPLETED_EVENT,
        extraKey: 'unexpected',
      }),
    ).toThrow();
  });

  it('RequestRoutedEventSchema rejects an event missing the upstream field', () => {
    const { upstream: _, ...withoutUpstream } = ANTHROPIC_COMPLETED_EVENT;
    expect(() => RequestRoutedEventSchema.parse(withoutUpstream)).toThrow();
  });

  it('RequestRoutedEventSchema rejects an unknown path', () => {
    expect(() =>
      RequestRoutedEventSchema.parse({
        ...ANTHROPIC_COMPLETED_EVENT,
        path: '/v1/chat/completions',
      }),
    ).toThrow();
  });

  it('RequestRoutedEventSchema rejects negative durationMs', () => {
    expect(() =>
      RequestRoutedEventSchema.parse({
        ...ANTHROPIC_COMPLETED_EVENT,
        durationMs: -1,
      }),
    ).toThrow();
  });

  it('RequestRoutedEventSchema rejects status outside 100-599 range', () => {
    expect(() =>
      RequestRoutedEventSchema.parse({
        ...ANTHROPIC_COMPLETED_EVENT,
        status: 99,
      }),
    ).toThrow();
  });
});

describe('gateway extension manifest', () => {
  it('has the correct name and displayName', () => {
    expect(gatewayExtension.name).toBe('gateway');
    expect(gatewayExtension.displayName).toBe('LLM Gateway');
  });

  it('http.prefix is /gateway', () => {
    expect(gatewayExtension.http?.prefix).toBe('/gateway');
  });

  it('has create and configSchema fields', () => {
    expect(typeof gatewayExtension.create).toBe('function');
    expect(gatewayExtension.configSchema).toBeDefined();
  });

  it('namespaces includes the GatewayNamespace', () => {
    expect(gatewayExtension.namespaces).toContainEqual(GatewayNamespace);
  });
});

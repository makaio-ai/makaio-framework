import { describe, expect, it } from 'vitest';
import type { AIModelMetadata } from '@makaio/contracts';
import { mergeModelMetadata } from '../merge-utils.js';

describe('mergeModelMetadata', () => {
  it('returns undefined when neither side supplies metadata', () => {
    expect(mergeModelMetadata(undefined, undefined)).toBeUndefined();
  });

  it('clones base-only metadata', () => {
    const base: AIModelMetadata = {
      maxOutputTokens: 1024,
      capabilities: {
        speechToText: { modes: ['batch'], vocabularyBiasing: true },
      },
      pricing: {
        token: { inputPerMillion: 1, outputPerMillion: 2 },
      },
    };

    const result = mergeModelMetadata(base, undefined);

    expect(result).toEqual(base);
    expect(result).not.toBe(base);
    expect(result?.capabilities).not.toBe(base.capabilities);
    expect(result?.capabilities?.speechToText).not.toBe(base.capabilities?.speechToText);
    expect(result?.pricing).not.toBe(base.pricing);
    expect(result?.pricing?.token).not.toBe(base.pricing?.token);

    result?.capabilities?.speechToText?.modes.push('streaming');
    if (result?.pricing?.token) {
      result.pricing.token.inputPerMillion = 99;
    }

    expect(base.capabilities?.speechToText?.modes).toEqual(['batch']);
    expect(base.pricing?.token?.inputPerMillion).toBe(1);
  });

  it('clones overlay-only metadata', () => {
    const overlay: AIModelMetadata = {
      description: 'Overlay metadata',
      capabilities: {
        textToSpeech: {
          modes: ['streaming'],
          outputFormats: ['pcm'],
        },
      },
      pricing: {
        request: { multiplier: 1 },
      },
    };

    const result = mergeModelMetadata(undefined, overlay);

    expect(result).toEqual(overlay);
    expect(result).not.toBe(overlay);
    expect(result?.capabilities).not.toBe(overlay.capabilities);
    expect(result?.capabilities?.textToSpeech).not.toBe(overlay.capabilities?.textToSpeech);
    expect(result?.pricing).not.toBe(overlay.pricing);
    expect(result?.pricing?.request).not.toBe(overlay.pricing?.request);

    result?.capabilities?.textToSpeech?.modes.push('streaming');
    result?.capabilities?.textToSpeech?.outputFormats?.push('mp3');
    if (result?.pricing?.request) {
      result.pricing.request.multiplier = 2;
    }

    expect(overlay.capabilities?.textToSpeech?.modes).toEqual(['streaming']);
    expect(overlay.capabilities?.textToSpeech?.outputFormats).toEqual(['pcm']);
    expect(overlay.pricing?.request?.multiplier).toBe(1);
  });

  it('merges top-level fields while replacing capabilities and pricing blocks', () => {
    const base: AIModelMetadata = {
      maxOutputTokens: 2048,
      includedInSubscription: false,
      capabilities: {
        vision: true,
        speechToText: { modes: ['batch'] },
      },
      pricing: {
        token: { inputPerMillion: 5, outputPerMillion: 10 },
      },
    };
    const overlay: AIModelMetadata = {
      includedInSubscription: true,
      capabilities: {
        toolCalling: true,
        textToSpeech: {
          modes: ['streaming'],
          outputFormats: ['wav'],
        },
      },
      pricing: {
        request: { multiplier: 0.5 },
      },
    };

    const result = mergeModelMetadata(base, overlay);

    expect(result).toEqual({
      maxOutputTokens: 2048,
      includedInSubscription: true,
      capabilities: overlay.capabilities,
      pricing: overlay.pricing,
    });
    expect(result).not.toBe(base);
    expect(result).not.toBe(overlay);
    expect(result?.capabilities).not.toBe(overlay.capabilities);
    expect(result?.pricing).not.toBe(overlay.pricing);

    result?.capabilities?.textToSpeech?.modes.push('streaming');
    result?.capabilities?.textToSpeech?.outputFormats?.push('mp3');
    if (result?.pricing?.request) {
      result.pricing.request.multiplier = 3;
    }

    expect(overlay.capabilities?.textToSpeech?.modes).toEqual(['streaming']);
    expect(overlay.capabilities?.textToSpeech?.outputFormats).toEqual(['wav']);
    expect(overlay.pricing?.request?.multiplier).toBe(0.5);
    expect(base.capabilities?.speechToText?.modes).toEqual(['batch']);
    expect(base.pricing?.token?.inputPerMillion).toBe(5);
  });

  it('retains cloned base capabilities and pricing when overlay is sparse', () => {
    const base: AIModelMetadata = {
      maxOutputTokens: 2048,
      capabilities: {
        speechToText: { modes: ['batch'], vocabularyBiasing: true },
      },
      pricing: {
        token: { inputPerMillion: 2, outputPerMillion: 8 },
      },
    };
    const overlay: AIModelMetadata = {
      description: 'Sparse provider note',
    };

    const result = mergeModelMetadata(base, overlay);

    expect(result).toEqual({
      maxOutputTokens: 2048,
      description: 'Sparse provider note',
      capabilities: base.capabilities,
      pricing: base.pricing,
    });
    expect(result).not.toBe(base);
    expect(result).not.toBe(overlay);
    expect(result?.capabilities).not.toBe(base.capabilities);
    expect(result?.pricing).not.toBe(base.pricing);

    result?.capabilities?.speechToText?.modes.push('streaming');
    if (result?.pricing?.token) {
      result.pricing.token.outputPerMillion = 99;
    }

    expect(base.capabilities?.speechToText?.modes).toEqual(['batch']);
    expect(base.pricing?.token?.outputPerMillion).toBe(8);
  });
});

import { describe, expect, it } from 'vitest';
import { cosineSimilarity, toEmbeddingBlob, toFloat32Array } from './vector-math.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical pre-normalized vectors', () => {
    const left = new Float32Array([0.6, 0.8]);
    const right = new Float32Array([0.6, 0.8]);
    expect(cosineSimilarity(left, right)).toBeCloseTo(1);
  });

  it('throws on dimension mismatch', () => {
    const left = new Float32Array([0.5, 0.5, 0.5]);
    const right = new Float32Array([0.5, 0.5]);
    expect(() => cosineSimilarity(left, right)).toThrow(/Vector dimension mismatch/);
  });
});

describe('embedding blob conversion', () => {
  it('round-trips toEmbeddingBlob -> toFloat32Array', () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const blob = toEmbeddingBlob(original);
    const roundTrip = toFloat32Array(blob);

    expect(roundTrip.length).toBe(original.length);
    for (let index = 0; index < original.length; index += 1) {
      expect(roundTrip[index]).toBeCloseTo(original[index]);
    }
  });

  it('handles Float32Array views with non-zero byteOffset', () => {
    const backing = new Float32Array([99, 0.25, 0.5, 0.75, 99]);
    const view = new Float32Array(backing.buffer, Float32Array.BYTES_PER_ELEMENT, 3);
    const blob = toEmbeddingBlob(view);
    const roundTrip = toFloat32Array(blob);

    expect(roundTrip.length).toBe(view.length);
    for (let index = 0; index < view.length; index += 1) {
      expect(roundTrip[index]).toBeCloseTo(view[index]);
    }
  });

  it('returns a zero-copy view for aligned binary input', () => {
    const bytes = Buffer.from(new Uint8Array(new Float32Array([1, 2]).buffer));
    const decoded = toFloat32Array(bytes);

    expect(decoded.buffer).toBe(bytes.buffer);
    expect(decoded.byteOffset).toBe(bytes.byteOffset);
  });

  it('rejects invalid byte lengths', () => {
    expect(() => toFloat32Array(Buffer.from([1, 2, 3]))).toThrow(/Invalid Float32Array byte length/);
  });

  it('copies when binary input has an unaligned byteOffset', () => {
    const source = new Float32Array([3, 4]);
    const prefixed = new Uint8Array(1 + source.byteLength);
    prefixed.set(new Uint8Array(source.buffer), 1);
    const misaligned = prefixed.subarray(1);

    const decoded = toFloat32Array(misaligned);

    expect(decoded[0]).toBeCloseTo(3);
    expect(decoded[1]).toBeCloseTo(4);
    expect(decoded.buffer).not.toBe(misaligned.buffer);
    expect(decoded.byteOffset).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../utils/ring-buffer.js';

describe('RingBuffer', () => {
  it('stores items up to max size', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.toArray()).toEqual([1, 2, 3]);
    expect(buffer.length).toBe(3);
  });

  it('drops oldest items when exceeding max size', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
    expect(buffer.length).toBe(3);
  });

  it('handles empty buffer', () => {
    const buffer = new RingBuffer<string>(5);
    expect(buffer.toArray()).toEqual([]);
    expect(buffer.length).toBe(0);
  });

  it('clears all items', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.clear();
    expect(buffer.toArray()).toEqual([]);
    expect(buffer.length).toBe(0);
  });

  it('uses default max size when not specified', () => {
    const buffer = new RingBuffer<number>();
    // Default is 50, push 51 items
    for (let i = 0; i < 51; i++) {
      buffer.push(i);
    }
    expect(buffer.length).toBe(50);
    expect(buffer.toArray()[0]).toBe(1); // First item (0) should be dropped
  });

  it('maintains order after multiple overflow cycles', () => {
    const buffer = new RingBuffer<number>(3);
    // Push 10 items into a buffer of size 3
    for (let i = 1; i <= 10; i++) {
      buffer.push(i);
    }
    expect(buffer.toArray()).toEqual([8, 9, 10]);
  });

  it('returns a copy of items, not the internal array', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    const arr = buffer.toArray();
    arr.push(999);
    expect(buffer.toArray()).toEqual([1]);
  });
});

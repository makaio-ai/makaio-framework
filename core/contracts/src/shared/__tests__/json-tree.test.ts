import { describe, expect, it } from 'vitest';
import { readDotPath } from '../json-tree.js';

describe('readDotPath', () => {
  const tree = { order: { state: 'open', items: [{ name: 'first' }, { name: 'second' }] }, empty: null };

  it('reads nested own properties', () => {
    expect(readDotPath(tree, 'order.state')).toBe('open');
    expect(readDotPath(tree, 'empty')).toBeNull();
  });

  it('indexes arrays with numeric segments', () => {
    expect(readDotPath(tree, 'order.items.0.name')).toBe('first');
    expect(readDotPath(tree, 'order.items.1.name')).toBe('second');
  });

  it('gives undefined for an index out of range or a non-index segment on an array', () => {
    expect(readDotPath(tree, 'order.items.2.name')).toBeUndefined();
    expect(readDotPath(tree, 'order.items.length')).toBeUndefined();
    expect(readDotPath(tree, 'order.items.01.name')).toBeUndefined();
    expect(readDotPath(tree, 'order.items.-1')).toBeUndefined();
  });

  it.each([
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'order.constructor',
    'order.__proto__.x',
  ])('does not follow the prototype chain for %s', (path) => {
    expect(readDotPath(tree, path)).toBeUndefined();
  });

  it('does not resolve a path through an inherited method', () => {
    expect(readDotPath(tree, 'a.hasOwnProperty')).toBeUndefined();
    expect(readDotPath({ a: {} }, 'a.hasOwnProperty')).toBeUndefined();
    expect(readDotPath({ a: [] }, 'a.constructor')).toBeUndefined();
  });

  it('reads an own property that shadows a prototype name', () => {
    const own = JSON.parse('{"__proto__":{"x":1},"constructor":"c"}');
    expect(readDotPath(own, 'constructor')).toBe('c');
    expect(readDotPath(own, '__proto__.x')).toBe(1);
  });

  it('gives undefined for a path through a non-object', () => {
    expect(readDotPath(tree, 'order.state.length')).toBeUndefined();
    expect(readDotPath(tree, 'empty.x')).toBeUndefined();
    expect(readDotPath(undefined, 'x')).toBeUndefined();
    expect(readDotPath('text', '0')).toBeUndefined();
  });
});

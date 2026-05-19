/**
 * Unit tests for {@link toCliArgManifests}.
 *
 * Verifies that Zod object schemas are correctly converted into serializable
 * {@link CliArgManifest} arrays, including optional/default unwrapping and
 * type inference.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { toCliArgManifests } from '../schema-introspection.js';

describe('toCliArgManifests', () => {
  it('returns an empty array for an empty schema', () => {
    const result = toCliArgManifests(z.object({}));
    expect(result).toEqual([]);
  });

  it('produces a required manifest for a required string field', () => {
    const schema = z.object({
      name: z.string().meta({ description: 'Name' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'name',
      description: 'Name',
      required: true,
    });
  });

  it('omits the required property for an optional string field', () => {
    const schema = z.object({
      filter: z.string().optional().meta({ description: 'Filter' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'filter',
      description: 'Filter',
    });
    expect(manifest).not.toHaveProperty('required');
  });

  it('sets positional:true for a positional argument', () => {
    const schema = z.object({
      id: z.string().meta({ positional: true, description: 'ID' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'id',
      description: 'ID',
      positional: true,
    });
  });

  it('propagates the short flag from meta', () => {
    const schema = z.object({
      client: z.string().optional().meta({ short: '-c', description: 'Client' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'client',
      description: 'Client',
      short: '-c',
    });
  });

  it('sets type:"boolean" for a boolean field', () => {
    const schema = z.object({
      verbose: z.boolean().optional().meta({ description: 'Verbose' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'verbose',
      description: 'Verbose',
      type: 'boolean',
    });
  });

  it('sets type:"number" and required:true for a required number field', () => {
    const schema = z.object({
      count: z.number().meta({ description: 'Count' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'count',
      description: 'Count',
      type: 'number',
      required: true,
    });
  });

  it('omits the type property for a string field (default type)', () => {
    const schema = z.object({
      label: z.string().meta({ description: 'Label' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).not.toHaveProperty('type');
  });

  it('resolves meta through a default wrapper', () => {
    const schema = z.object({
      format: z.enum(['table', 'json']).default('table').meta({ description: 'Format' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'format',
      description: 'Format',
    });
    // default() makes the field optional
    expect(manifest).not.toHaveProperty('required');
  });

  it('resolves meta on the inner schema when optional wraps a meta-annotated field', () => {
    const schema = z.object({
      deep: z.string().meta({ description: 'Deep' }).optional(),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'deep',
      description: 'Deep',
    });
    expect(manifest).not.toHaveProperty('required');
  });

  it('merges wrapper and inner metadata instead of dropping either side', () => {
    const schema = z.object({
      id: z.string().meta({ positional: true }).optional().meta({ description: 'Identifier' }),
    });

    const [manifest] = toCliArgManifests(schema);

    expect(manifest).toMatchObject({
      name: 'id',
      description: 'Identifier',
      positional: true,
    });
  });

  it('preserves declaration order across multiple fields', () => {
    const schema = z.object({
      alpha: z.string().meta({ description: 'Alpha' }),
      beta: z.number().optional().meta({ description: 'Beta' }),
      gamma: z.boolean().meta({ description: 'Gamma' }),
    });

    const manifests = toCliArgManifests(schema);

    expect(manifests).toHaveLength(3);
    expect(manifests[0]?.name).toBe('alpha');
    expect(manifests[1]?.name).toBe('beta');
    expect(manifests[2]?.name).toBe('gamma');
  });
});

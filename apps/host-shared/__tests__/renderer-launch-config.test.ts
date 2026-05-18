import { describe, expect, it } from 'vitest';
import {
  buildRendererLaunchUrl,
  createRendererLaunchConfig,
  encodeRendererParams,
} from '../src/renderer-launch-config.js';

const registration = {
  packageName: 'test.package',
  qualifiedId: 'test.package:main',
};

describe('renderer-launch-config', () => {
  it('creates host-neutral renderer launch config', () => {
    expect(
      createRendererLaunchConfig({
        baseUrl: 'http://127.0.0.1:6252/',
        busUrl: 'ws://127.0.0.1:6252/bus',
        registration,
        params: { projectId: 'project-1' },
        bootComplete: true,
      }),
    ).toEqual({
      baseUrl: 'http://127.0.0.1:6252/',
      busUrl: 'ws://127.0.0.1:6252/bus',
      packageName: 'test.package',
      windowId: 'test.package:main',
      params: { projectId: 'project-1' },
      bootComplete: true,
    });
  });

  it('serializes the common app/window URL shape without runtime config by default', () => {
    const url = buildRendererLaunchUrl(
      createRendererLaunchConfig({
        baseUrl: 'http://127.0.0.1:6252/',
        busUrl: 'ws://127.0.0.1:6252/bus',
        registration,
        params: { projectId: 'project-1' },
        bootComplete: true,
      }),
    );

    expect(url).toBe('http://127.0.0.1:6252/?app=test.package&window=test.package%3Amain&projectId=project-1');
  });

  it('can include runtime config for query-param hosts', () => {
    const url = new URL(
      buildRendererLaunchUrl(
        createRendererLaunchConfig({
          baseUrl: 'http://127.0.0.1:6252/',
          busUrl: 'ws://127.0.0.1:6252/bus',
          registration,
          bootComplete: false,
        }),
        { includeBootComplete: true, includeBusUrl: true },
      ),
    );

    expect(url.searchParams.get('busUrl')).toBe('ws://127.0.0.1:6252/bus');
    expect(url.searchParams.get('bootComplete')).toBe('0');
  });

  it('rejects params that would overwrite reserved bootstrap query keys', () => {
    expect(() =>
      buildRendererLaunchUrl(
        createRendererLaunchConfig({
          baseUrl: 'http://127.0.0.1:6252/',
          busUrl: 'ws://127.0.0.1:6252/bus',
          registration,
          params: { app: 'other.package' },
          bootComplete: true,
        }),
      ),
    ).toThrow('[renderer-launch-config] Reserved query key "app" cannot be set via params.');
  });

  it('encodes params for preload transports', () => {
    expect(decodeURIComponent(encodeRendererParams({ projectId: 'project-1' }))).toBe('{"projectId":"project-1"}');
  });
});

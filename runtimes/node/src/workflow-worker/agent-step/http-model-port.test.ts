import { createServer } from 'node:http';
import { MakaioBus } from '@makaio/bus-core';
import { describe, expect, it } from 'vitest';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { createHttpWorkerModelPort } from './http-model-port.js';

const credential = 'fixture-???~~~/%-credential';
const rejected = { kind: 'failed', code: 'reply-invalid' };

/**
 * Send one request through the model port to a real HTTP upstream.
 * @param value - Synthetic authorization issued to the port.
 * @param text - Model reply text.
 * @returns The port result and the number of upstream requests.
 */
async function complete(value: string, text: string) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.end(JSON.stringify({ text }));
  });
  const port = await listenOnLoopback(server);
  try {
    const target = 'model';
    const model = createHttpWorkerModelPort('fixture-model', {
      name: target,
      url: new URL(`http://127.0.0.1:${port}`),
    });
    const result = await model.complete({
      call: MakaioBus.own('root'),
      request: { model: 'fixture-model', prompt: 'Review' },
      credentialSource: { request: async () => ({ kind: 'issued', credential: value }) },
      signal: new AbortController().signal,
      target,
    });
    return { result, requests };
  } finally {
    await closeHttpServer(server);
  }
}

describe('HTTP worker model port reply filter', () => {
  it.each([
    'text',
    'fixture-short       ',
    'fixture-auth-15',
  ])('refuses short authorization before sending a request (%s)', async (value) => {
    await expect(complete(value, 'ordinary text')).resolves.toEqual({
      result: { kind: 'failed', code: 'environmentMissing' },
      requests: 0,
    });
  });

  it('sends a 16-byte authorization and rejects its reflection', async () => {
    const value = 'fixture-auth-016';
    await expect(complete(value, value)).resolves.toEqual({ result: rejected, requests: 1 });
  });

  it('rejects the effective Authorization value after surrounding whitespace is removed', async () => {
    await expect(complete(` ${credential} `, credential)).resolves.toEqual({ result: rejected, requests: 1 });
  });

  it('rejects the base64 representation of non-ASCII bytes from the Authorization header', async () => {
    const value = 'fixture-credential-é';
    const text = Buffer.from(value, 'latin1').toString('base64');
    await expect(complete(value, text)).resolves.toEqual({ result: rejected, requests: 1 });
  });

  it.each([0, 1, 2])('rejects base64 in either alphabet at byte offset %i', async (offset) => {
    const standard = Buffer.from(`${'x'.repeat(offset)}${credential}${offset === 0 ? 'x' : ''}`).toString('base64');
    const url = standard.replaceAll('+', '-').replaceAll('/', '_');
    expect(standard).toMatch(/=$/);
    expect(url).not.toBe(standard);
    for (const encoded of [standard, url, standard.replace(/=+$/, ''), url.replace(/=+$/, '')]) {
      await expect(complete(credential, encoded)).resolves.toEqual({ result: rejected, requests: 1 });
    }
  });

  it.each([
    ['CRLF', '\r\n'],
    ['indented CRLF', '\r\n '],
    ['tab', '\t'],
    ['form feed', '\f'],
    ['vertical tab', '\v'],
  ])('rejects a wrapped base64 credential split by %s', async (_name, separator) => {
    const encoded = Buffer.from(`${'x'.repeat(55)}${credential}x`).toString('base64');
    const wrapped = `${encoded.slice(0, 76)}${separator}${encoded.slice(76)}`;
    await expect(complete(credential, wrapped)).resolves.toEqual({ result: rejected, requests: 1 });
  });

  it('rejects a base64 credential separated into groups of four characters', async () => {
    const encoded = Buffer.from(credential).toString('base64');
    const grouped = encoded.replace(/.{4}/g, '$& ').trimEnd();
    await expect(complete(credential, grouped)).resolves.toEqual({ result: rejected, requests: 1 });
  });

  it('accepts prose with whitespace and unrelated base64', async () => {
    const encoded = Buffer.from('synthetic reply fixture data').toString('base64').replace(/.{4}/g, '$& ').trimEnd();
    const text = `The  example  contains:\n  ${encoded}\n\tEnd  of  example.`;
    await expect(complete(credential, text)).resolves.toEqual({
      result: { kind: 'completed', reply: { text } },
      requests: 1,
    });
  });

  it.each([
    0, 1, 2,
  ])('accepts nearby base64 bytes that differ from the credential at byte offset %i', async (offset) => {
    for (const other of [`g${credential.slice(1)}`, `${credential.slice(0, -1)}m`]) {
      const text = Buffer.from(`${'x'.repeat(offset)}${other}x`).toString('base64');
      await expect(complete(credential, text)).resolves.toEqual({
        result: { kind: 'completed', reply: { text } },
        requests: 1,
      });
    }
  });

  it('checks the leading shared base64 bits at byte offset one', async () => {
    // The first bytes, f (0x66) and v (0x76), differ only in the high nibble stored in the shared sextet.
    const text = Buffer.from(`xv${credential.slice(1)}x`).toString('base64');
    const reflected = Buffer.from(`x${credential}x`).toString('base64');
    await expect(complete(credential, text)).resolves.toEqual({
      result: { kind: 'completed', reply: { text } },
      requests: 1,
    });
    await expect(complete(credential, reflected)).resolves.toEqual({ result: rejected, requests: 1 });
  });

  it('rejects percent encoding with mixed-case hex digits', async () => {
    const text = encodeURIComponent(credential).replace('%3F', '%3f');
    expect(text).not.toBe(credential);
    await expect(complete(credential, text)).resolves.toEqual({ result: rejected, requests: 1 });
  });
});

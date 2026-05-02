import { describe, expect, it } from 'vitest';
import { buildBootErrorHtml } from '../src/main/boot-error.js';

describe('buildBootErrorHtml', () => {
  it('includes the error message in the HTML body', () => {
    const html = buildBootErrorHtml(new Error('EADDRINUSE: port 6252'));
    expect(html).toContain('EADDRINUSE: port 6252');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Quit');
  });

  it('escapes HTML characters in the error message', () => {
    const html = buildBootErrorHtml(new Error('<script>alert("xss\'s")</script>'));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&#39;');
  });

  it('handles non-Error values gracefully', () => {
    const html = buildBootErrorHtml('string error');
    expect(html).toContain('string error');
  });
});

import { describe, expect, it } from 'vitest';

describe('framework UI browser harness', () => {
  it('runs tests in a real browser document', () => {
    const element = document.createElement('section');

    try {
      element.style.display = 'grid';
      document.body.append(element);
      expect(window.getComputedStyle(element).display).toBe('grid');
    } finally {
      element.remove();
    }
  });
});

/**
 * \@vitest-environment node
 */

import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ModalPortal } from '../ModalPortal.js';

describe('ModalPortal', () => {
  it('returns null when rendered without a DOM (SSR)', () => {
    const result = ModalPortal({
      children: createElement('div', null, 'Modal content'),
    });

    expect(result).toBeNull();
  });
});

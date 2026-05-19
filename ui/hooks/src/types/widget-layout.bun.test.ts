/**
 * Widget Layout Helper Tests
 *
 * Tests for FocusContextLayout helper functions, focusing on
 * documented contracts (referential equality on no-op, mutation isolation).
 */

import { describe, it, expect } from 'bun:test';
import {
  createEmptyFocusContextLayout,
  addWidgetToFocusLayout,
  removeWidgetFromFocusLayout,
  updateFocusContextWidgetSize,
  updateFocusContextWidgetPosition,
} from './widget-layout.js';
import type { FocusContextLayout } from './widget-layout.js';

/**
 * Returns a fresh single-widget layout for each test so cases do not share
 * object identity and cannot accidentally influence each other.
 */
function makeLayoutWithOne(): FocusContextLayout {
  return { version: 1, widgets: [{ widgetId: 'widget-a', size: 'medium' }] };
}

describe('widget-layout helpers', () => {
  describe('createEmptyFocusContextLayout', () => {
    it('should return a layout with no widgets', () => {
      const layout = createEmptyFocusContextLayout();

      expect(layout.version).toBe(1);
      expect(layout.widgets).toHaveLength(0);
    });
  });

  describe('addWidgetToFocusLayout', () => {
    it('should add a new widget to the layout', () => {
      const layoutWithOne = makeLayoutWithOne();
      const result = addWidgetToFocusLayout(layoutWithOne, { widgetId: 'widget-b', size: 'small' });

      expect(result.widgets).toHaveLength(2);
      expect(result.widgets[1].widgetId).toBe('widget-b');
    });

    it('should return the original layout (referential equality) on duplicate widgetId', () => {
      const layoutWithOne = makeLayoutWithOne();
      const result = addWidgetToFocusLayout(layoutWithOne, { widgetId: 'widget-a', size: 'large' });

      expect(result).toBe(layoutWithOne);
    });
  });

  describe('removeWidgetFromFocusLayout', () => {
    it('should remove the widget with the given ID', () => {
      const layoutWithOne = makeLayoutWithOne();
      const result = removeWidgetFromFocusLayout(layoutWithOne, 'widget-a');

      expect(result.widgets).toHaveLength(0);
    });

    it('should return the original layout (referential equality) when widgetId is not found', () => {
      const layoutWithOne = makeLayoutWithOne();
      const result = removeWidgetFromFocusLayout(layoutWithOne, 'nonexistent');

      expect(result.widgets).toHaveLength(1);
      expect(result).toBe(layoutWithOne);
    });
  });

  describe('updateFocusContextWidgetSize', () => {
    it('should update the size of the target widget', () => {
      const layoutWithOne = makeLayoutWithOne();
      const result = updateFocusContextWidgetSize(layoutWithOne, 'widget-a', 'large');

      expect(result.widgets[0].size).toBe('large');
    });

    it('should return the original layout (referential equality) when widgetId is not found', () => {
      const layoutWithOne = makeLayoutWithOne();
      const result = updateFocusContextWidgetSize(layoutWithOne, 'nonexistent', 'large');

      expect(result).toBe(layoutWithOne);
    });

    it('should not mutate the original layout', () => {
      const layoutWithOne = makeLayoutWithOne();
      updateFocusContextWidgetSize(layoutWithOne, 'widget-a', 'small');

      expect(layoutWithOne.widgets[0].size).toBe('medium');
    });
  });

  describe('updateFocusContextWidgetPosition', () => {
    it('should update position fields on the target widget', () => {
      const layoutWithOne = makeLayoutWithOne();
      const result = updateFocusContextWidgetPosition(layoutWithOne, 'widget-a', { x: 10, y: 20, width: 3, height: 2 });

      expect(result.widgets[0].x).toBe(10);
      expect(result.widgets[0].y).toBe(20);
      expect(result.widgets[0].width).toBe(3);
      expect(result.widgets[0].height).toBe(2);
    });

    it('should return the original layout (referential equality) when widgetId is not found', () => {
      const layoutWithOne = makeLayoutWithOne();
      const result = updateFocusContextWidgetPosition(layoutWithOne, 'nonexistent', { x: 5, y: 5 });

      expect(result).toBe(layoutWithOne);
    });

    it('should not mutate the original layout', () => {
      const layoutWithOne = makeLayoutWithOne();
      updateFocusContextWidgetPosition(layoutWithOne, 'widget-a', { x: 99 });

      expect(layoutWithOne.widgets[0].x).toBeUndefined();
    });
  });
});

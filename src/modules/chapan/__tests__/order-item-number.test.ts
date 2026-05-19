import { describe, expect, it } from 'vitest';
import {
  formatOrderItemNumber,
  parseOrderItemNumber,
  stripOrderItemSuffix,
} from '../order-item-number.js';

describe('order item number helpers', () => {
  it('does not strip the numeric part of a base order number', () => {
    expect(stripOrderItemSuffix('ORD-323')).toBe('ORD-323');
    expect(formatOrderItemNumber('ORD-323', 1)).toBe('ORD-323-1');
  });

  it('strips only the trailing item suffix from numbered positions', () => {
    expect(stripOrderItemSuffix('ORD-323-2')).toBe('ORD-323');
    expect(parseOrderItemNumber('ORD-323-2')).toEqual({
      orderNumber: 'ORD-323',
      position: 2,
    });
  });

  it('treats plain order numbers as orders, not as item positions', () => {
    expect(parseOrderItemNumber('ORD-323')).toEqual({
      orderNumber: 'ORD-323',
      position: null,
    });
  });
});

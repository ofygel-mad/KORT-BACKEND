import { describe, expect, it } from 'vitest';
import { purchaseListQuerySchema } from '../purchase.routes.js';

describe('purchase list query parsing', () => {
  it('keeps archived=false as boolean false', () => {
    const parsed = purchaseListQuerySchema.parse({ type: 'workshop', archived: 'false' });
    expect(parsed).toEqual({ type: 'workshop', archived: false });
  });

  it('keeps archived=true as boolean true', () => {
    const parsed = purchaseListQuerySchema.parse({ type: 'market', archived: 'true' });
    expect(parsed).toEqual({ type: 'market', archived: true });
  });
});

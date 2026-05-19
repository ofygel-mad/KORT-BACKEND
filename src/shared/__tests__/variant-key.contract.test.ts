import { describe, it, expect } from 'vitest';
import { buildCanonicalVariantKey } from '../variant-key.js';
import { VARIANT_KEY_FIXTURES } from './variant-key.fixture.js';

describe('buildCanonicalVariantKey (server) — golden contract', () => {
  for (const fixture of VARIANT_KEY_FIXTURES) {
    it(fixture.name, () => {
      const actual = buildCanonicalVariantKey(
        fixture.productName,
        fixture.attributes,
        fixture.fields,
      );
      expect(actual).toBe(fixture.expected);
    });
  }

  it('throws if fields is undefined (forces explicit choice)', () => {
    expect(() =>
      buildCanonicalVariantKey('Test', { color: 'red' }, undefined as unknown as never),
    ).toThrow(/fields must be an array/);
  });

  it('is deterministic regardless of input attribute order', () => {
    const fields = [
      { code: 'a', affectsAvailability: true },
      { code: 'b', affectsAvailability: true },
      { code: 'c', affectsAvailability: true },
    ];
    const k1 = buildCanonicalVariantKey('X', { a: '1', b: '2', c: '3' }, fields);
    const k2 = buildCanonicalVariantKey('X', { c: '3', a: '1', b: '2' }, fields);
    expect(k1).toBe(k2);
  });
});

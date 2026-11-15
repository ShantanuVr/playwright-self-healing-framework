/**
 * @file SimilarityUtils.test.ts
 * @description Unit tests for the pure similarity helpers. No I/O, no
 *              browser – these tests run under Vitest in < 100 ms.
 */

import { describe, it, expect } from 'vitest';
import { SimilarityUtils } from './SimilarityUtils';

describe('SimilarityUtils.levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(SimilarityUtils.levenshtein('submit', 'submit')).toBe(0);
  });

  it('returns length of the other string when one side is empty', () => {
    expect(SimilarityUtils.levenshtein('', 'submit')).toBe(6);
    expect(SimilarityUtils.levenshtein('submit', '')).toBe(6);
  });

  it('counts single substitutions', () => {
    expect(SimilarityUtils.levenshtein('cat', 'bat')).toBe(1);
  });

  it('counts multiple edits correctly', () => {
    // kitten -> sitten (1) -> sittin (2) -> sitting (3)
    expect(SimilarityUtils.levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('is symmetric', () => {
    const a = 'submit-order';
    const b = 'btn_a1b2c3d4';
    expect(SimilarityUtils.levenshtein(a, b)).toBe(
      SimilarityUtils.levenshtein(b, a),
    );
  });
});

describe('SimilarityUtils.stringSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(SimilarityUtils.stringSimilarity('Submit', 'Submit')).toBe(1);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(
      SimilarityUtils.stringSimilarity('  Submit Order  ', 'submit order'),
    ).toBe(1);
  });

  it('returns 1 when both sides are empty/undefined', () => {
    expect(SimilarityUtils.stringSimilarity('', '')).toBe(1);
    expect(SimilarityUtils.stringSimilarity(undefined, undefined)).toBe(1);
  });

  it('returns 0 when exactly one side is empty', () => {
    expect(SimilarityUtils.stringSimilarity('', 'anything')).toBe(0);
    expect(SimilarityUtils.stringSimilarity('anything', '')).toBe(0);
  });

  it('returns a value in (0, 1) for partial matches', () => {
    const score = SimilarityUtils.stringSimilarity('Submit Order', 'Place Order');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('is close to 1 for minor mutations', () => {
    const score = SimilarityUtils.stringSimilarity('submit-order', 'submit_order');
    expect(score).toBeGreaterThan(0.9);
  });
});

describe('SimilarityUtils.jaccard', () => {
  it('returns 1 for identical sets', () => {
    expect(SimilarityUtils.jaccard(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(1);
  });

  it('returns 1 when both sides are empty', () => {
    expect(SimilarityUtils.jaccard([], [])).toBe(1);
  });

  it('returns 0 when exactly one side is empty', () => {
    expect(SimilarityUtils.jaccard([], ['x'])).toBe(0);
  });

  it('returns intersection/union for partial overlap', () => {
    // A={a,b,c}, B={b,c,d}; intersect=2, union=4 -> 0.5
    expect(SimilarityUtils.jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
  });

  it('is case-insensitive', () => {
    expect(SimilarityUtils.jaccard(['Btn', 'Primary'], ['btn', 'primary'])).toBe(1);
  });

  it('deduplicates tokens on each side', () => {
    expect(SimilarityUtils.jaccard(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1);
  });
});

describe('SimilarityUtils.tokenize', () => {
  it('splits on whitespace, hyphens, underscores, slashes, dots, colons', () => {
    expect(SimilarityUtils.tokenize('Submit-Order_btn.primary/cta:v2'))
      .toEqual(['submit', 'order', 'btn', 'primary', 'cta', 'v2']);
  });

  it('drops empty fragments from consecutive separators', () => {
    expect(SimilarityUtils.tokenize('--foo__bar')).toEqual(['foo', 'bar']);
  });

  it('returns [] for empty / undefined inputs', () => {
    expect(SimilarityUtils.tokenize('')).toEqual([]);
    expect(SimilarityUtils.tokenize(undefined)).toEqual([]);
  });

  it('lowercases every token', () => {
    expect(SimilarityUtils.tokenize('CheckoutForm')).toEqual(['checkoutform']);
  });
});

describe('SimilarityUtils.cosine', () => {
  it('returns 1 for identical and for scaled vectors', () => {
    expect(SimilarityUtils.cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(SimilarityUtils.cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(SimilarityUtils.cosine([1, 0], [0, 1])).toBe(0);
  });

  it('clamps opposite vectors to 0 instead of going negative', () => {
    expect(SimilarityUtils.cosine([1, 0], [-1, 0])).toBe(0);
  });

  it('returns 0 for empty, zero or mismatched-length vectors', () => {
    expect(SimilarityUtils.cosine([], [])).toBe(0);
    expect(SimilarityUtils.cosine([0, 0], [1, 1])).toBe(0);
    expect(SimilarityUtils.cosine([1, 2], [1, 2, 3])).toBe(0);
  });

  it('is symmetric and stays within [0, 1]', () => {
    const a = [0.3, -0.2, 0.9];
    const b = [0.1, 0.4, 0.7];
    expect(SimilarityUtils.cosine(a, b)).toBe(SimilarityUtils.cosine(b, a));
    expect(SimilarityUtils.cosine(a, b)).toBeGreaterThan(0);
    expect(SimilarityUtils.cosine(a, b)).toBeLessThan(1);
  });
});

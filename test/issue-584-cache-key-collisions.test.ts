import { describe, expect, it } from 'vitest';

import { createReadCacheKey } from '../src/cache';

describe('Issue #584: createReadCacheKey escapes method names and arguments', () => {
  it('does not collide when the method name contains the old ":" delimiter', () => {
    // Previously both produced `a:b:{"c":1}`-style ambiguous keys.
    const nested = createReadCacheKey('a:{}', {});
    const plain = createReadCacheKey('a', {});
    expect(nested).not.toBe(plain);
  });

  it('does not collide when the method name contains "::" or JSON-like text', () => {
    const keys = new Set([
      createReadCacheKey('get_will', { willId: '1' }),
      createReadCacheKey('get_will::', { willId: '1' }),
      createReadCacheKey('get_will:{"willId":"1"}', {}),
      createReadCacheKey('get_will:{"willId":"1"}:', {}),
      createReadCacheKey('get_will"', { willId: '1' }),
      createReadCacheKey('get_will\\', { willId: '1' }),
      createReadCacheKey('', { willId: '1' }),
    ]);
    expect(keys.size).toBe(7);
  });

  it('does not collide when argument strings contain delimiters or quotes', () => {
    const a = createReadCacheKey('m', { x: 'a","y":"b' });
    const b = createReadCacheKey('m', { x: 'a', y: 'b' });
    expect(a).not.toBe(b);
  });

  it('keeps keys stable regardless of argument order', () => {
    expect(createReadCacheKey('m::x', { b: 1, a: 2 })).toBe(createReadCacheKey('m::x', { a: 2, b: 1 }));
  });

  it('round-trips the method name and arguments unambiguously', () => {
    const key = createReadCacheKey('weird::method:"name"', { owner: 'G::A' });
    expect(JSON.parse(key)).toEqual(['weird::method:"name"', { owner: 'G::A' }]);
  });
});

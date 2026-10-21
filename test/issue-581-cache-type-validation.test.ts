/**
 * Tests for issue #581: cache deserialization doesn't validate __type values.
 *
 * Fix: deserializeCacheValue now only accepts the `bigint` and `date` tags
 * written by the serializer and throws CacheDeserializationError for anything
 * else. ReadCache hydration discards such malformed entries (logging a
 * warning and removing them from persistence) instead of returning them.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  CacheDeserializationError,
  MemoryCachePersistenceAdapter,
  ReadCache,
} from '../src/cache';
import type { PersistedCacheEntry } from '../src/cache';

function entry(key: string, value: string): PersistedCacheEntry {
  return { key, value, expiresAt: null, willIds: ['1'] };
}

async function hydrateWith(entries: PersistedCacheEntry[]) {
  const persistence = new MemoryCachePersistenceAdapter();
  for (const e of entries) await persistence.write(e);
  const cache = new ReadCache({ persistence });
  await cache.ready();
  return { cache, persistence };
}

describe('ReadCache — __type validation on deserialization (#581)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still deserializes valid bigint and date tags', async () => {
    const { cache } = await hydrateWith([
      entry(
        'valid',
        JSON.stringify({
          amount: { __type: 'bigint', value: '12345678901234567890' },
          at: { __type: 'date', value: '2026-01-01T00:00:00.000Z' },
        }),
      ),
    ]);

    const value = cache.get<{ amount: bigint; at: Date }>('valid');
    expect(value?.amount).toBe(12345678901234567890n);
    expect(value?.at).toBeInstanceOf(Date);
    expect(value?.at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('round-trips bigint and Date values written through the cache', async () => {
    const persistence = new MemoryCachePersistenceAdapter();
    const writer = new ReadCache({ persistence });
    await writer.ready();
    writer.set('k', { amount: 42n, at: new Date('2026-02-03T04:05:06.000Z') });

    const reader = new ReadCache({ persistence });
    await reader.ready();
    const value = reader.get<{ amount: bigint; at: Date }>('k');
    expect(value?.amount).toBe(42n);
    expect(value?.at.getTime()).toBe(new Date('2026-02-03T04:05:06.000Z').getTime());
  });

  it.each([
    ['unknown string type', { __type: 'map', value: '{}' }],
    ['uppercase variant', { __type: 'BigInt', value: '1' }],
    ['empty string type', { __type: '', value: '1' }],
    ['numeric type', { __type: 1, value: '1' }],
    ['null type', { __type: null, value: '1' }],
  ])('discards entries with an invalid __type: %s', async (_label, wrapper) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cache, persistence } = await hydrateWith([
      entry('bad', JSON.stringify({ nested: wrapper })),
      entry('good', JSON.stringify({ ok: true })),
    ]);

    expect(cache.get('bad')).toBeUndefined();
    expect(cache.get('good')).toEqual({ ok: true });
    expect((await persistence.readAll()).map((e) => e.key)).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBeInstanceOf(CacheDeserializationError);
  });

  it.each([
    ['non-string bigint value', { __type: 'bigint', value: 5 }],
    ['unparseable bigint value', { __type: 'bigint', value: 'not-a-number' }],
    ['unparseable date value', { __type: 'date', value: 'not-a-date' }],
  ])('discards entries with a malformed tagged value: %s', async (_label, wrapper) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cache } = await hydrateWith([entry('bad', JSON.stringify(wrapper))]);

    expect(cache.get('bad')).toBeUndefined();
    expect(warn.mock.calls[0]?.[1]).toBeInstanceOf(CacheDeserializationError);
  });

  it('leaves objects that merely have a __type field without a value untouched', async () => {
    const { cache } = await hydrateWith([
      entry('plain', JSON.stringify({ __type: 'custom', name: 'x' })),
    ]);

    expect(cache.get('plain')).toEqual({ __type: 'custom', name: 'x' });
  });
});

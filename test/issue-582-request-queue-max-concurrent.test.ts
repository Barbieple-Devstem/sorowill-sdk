/**
 * Tests for issue #582: RequestQueue constructor doesn't validate maxConcurrent
 * is positive.
 *
 * Passing 0, a negative number, or NaN would leave `active < maxConcurrent`
 * permanently false (or ill-defined) so queued requests never run. The
 * constructor must reject these values with a RangeError.
 */

import { describe, it, expect } from 'vitest';
import { RequestQueue } from '../src/requestQueue';

describe('RequestQueue — maxConcurrent validation (#582)', () => {
  it.each([
    ['0', 0],
    ['-1', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['0.5', 0.5],
    ['1.5', 1.5],
  ])('throws RangeError for maxConcurrent = %s', (_label, value) => {
    expect(() => new RequestQueue({ maxConcurrent: value })).toThrow(RangeError);
    expect(() => new RequestQueue({ maxConcurrent: value })).toThrow(
      /maxConcurrent must be a positive integer/,
    );
  });

  it('includes the received value in the error message', () => {
    expect(() => new RequestQueue({ maxConcurrent: 0 })).toThrow(/received 0/);
    expect(() => new RequestQueue({ maxConcurrent: -1 })).toThrow(/received -1/);
    expect(() => new RequestQueue({ maxConcurrent: Number.NaN })).toThrow(/received NaN/);
  });

  it('throws RangeError for non-number maxConcurrent values', () => {
    expect(() => new RequestQueue({ maxConcurrent: '2' as unknown as number })).toThrow(RangeError);
    expect(() => new RequestQueue({ maxConcurrent: null as unknown as number })).toThrow(RangeError);
  });

  it('does not register a shared account core when validation fails', async () => {
    const account = 'GISSUE582ACCOUNT';
    expect(() => new RequestQueue({ account, maxConcurrent: 0 })).toThrow(RangeError);

    // A later valid queue for the same account must get its own working core.
    const queue = new RequestQueue({ account, maxConcurrent: 1 });
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
    queue.release();
  });

  it('accepts the lower boundary maxConcurrent = 1 and runs requests', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1 });
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('uses the default maxConcurrent when omitted or undefined', async () => {
    expect(() => new RequestQueue()).not.toThrow();
    const queue = new RequestQueue({ maxConcurrent: undefined });
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it.each([
    ['0', 0],
    ['-1', -1],
    ['NaN', Number.NaN],
  ])('throws RangeError for requestsPerSecond = %s', (_label, value) => {
    expect(() => new RequestQueue({ requestsPerSecond: value })).toThrow(RangeError);
  });
});

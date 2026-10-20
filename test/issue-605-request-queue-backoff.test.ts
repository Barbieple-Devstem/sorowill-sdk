import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_BACKOFF_MS,
  RequestQueue,
  computeBackoffDelay,
  isRateLimitError,
} from '../src/requestQueue';

describe('#605 RequestQueue exponential backoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes 2^n * delay for each retry', () => {
    expect(computeBackoffDelay(0, 100)).toBe(100);
    expect(computeBackoffDelay(1, 100)).toBe(200);
    expect(computeBackoffDelay(2, 100)).toBe(400);
    expect(computeBackoffDelay(3, 100)).toBe(800);
  });

  it('caps the backoff at 60 seconds', () => {
    expect(MAX_BACKOFF_MS).toBe(60_000);
    expect(computeBackoffDelay(20, 500)).toBe(60_000);
    expect(computeBackoffDelay(10_000, 500)).toBe(60_000);
  });

  it('rejects a maxBackoffMs above the 60s cap', () => {
    expect(() => new RequestQueue({ maxBackoffMs: 120_000 })).toThrow(RangeError);
  });

  it('classifies rate-limit errors', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(isRateLimitError(new Error('contract panicked'))).toBe(false);
  });

  it('retries rate-limited requests with exponentially growing delays', async () => {
    vi.useFakeTimers();
    const queue = new RequestQueue({ retryBaseDelayMs: 100, maxRateLimitRetries: 3 });
    const attemptTimes: number[] = [];
    const start = Date.now();

    const promise = queue.enqueue(async () => {
      attemptTimes.push(Date.now() - start);
      if (attemptTimes.length < 4) throw new Error('429 Too Many Requests');
      return 'ok';
    });

    await vi.advanceTimersByTimeAsync(100 + 200 + 400);
    await expect(promise).resolves.toBe('ok');

    const gaps = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i]!);
    expect(gaps).toEqual([100, 200, 400]);
  });

  it('surfaces the rate-limit error once retries are exhausted', async () => {
    vi.useFakeTimers();
    const queue = new RequestQueue({ retryBaseDelayMs: 10, maxRateLimitRetries: 2 });
    const run = vi.fn().mockRejectedValue(new Error('rate limit exceeded'));

    const promise = queue.enqueue(run);
    const assertion = expect(promise).rejects.toThrow('rate limit exceeded');
    await vi.advanceTimersByTimeAsync(10 + 20);
    await assertion;
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-rate-limit errors', async () => {
    const queue = new RequestQueue({ retryBaseDelayMs: 10 });
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(queue.enqueue(run)).rejects.toThrow('boom');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

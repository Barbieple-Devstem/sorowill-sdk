import { describe, expect, it } from 'vitest';

import { InFlightTracker } from '../src/inFlightTracker';

describe('Issue #585: InFlightTracker.track handles synchronous operation throws', () => {
  it('returns a rejected promise instead of throwing synchronously', async () => {
    const tracker = new InFlightTracker();
    const boom = new Error('sync boom');

    let result: Promise<unknown> | undefined;
    expect(() => {
      result = tracker.track('1', 'checkIn', () => {
        throw boom;
      });
    }).not.toThrow();

    await expect(result).rejects.toBe(boom);
  });

  it('does not leave an orphaned in-flight entry after a sync throw', async () => {
    const tracker = new InFlightTracker();

    await expect(
      tracker.track('1', 'checkIn', () => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');

    expect(tracker.size).toBe(0);
    expect(tracker.isInFlight('1', 'checkIn')).toBe(false);
    expect(tracker.getInFlightPromise('1', 'checkIn')).toBeUndefined();
  });

  it('allows a subsequent call for the same key to run after a sync throw', async () => {
    const tracker = new InFlightTracker();

    await expect(
      tracker.track('1', 'checkIn', () => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');

    await expect(tracker.track('1', 'checkIn', async () => 'ok')).resolves.toBe('ok');
    expect(tracker.size).toBe(0);
  });

  it('does not displace an existing in-flight entry for another key', async () => {
    const tracker = new InFlightTracker();
    let resolveOther: (value: string) => void = () => {};
    const other = tracker.track(
      '2',
      'checkIn',
      () => new Promise<string>((resolve) => (resolveOther = resolve)),
    );

    await expect(
      tracker.track('1', 'checkIn', () => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');

    expect(tracker.size).toBe(1);
    expect(tracker.isInFlight('2', 'checkIn')).toBe(true);

    resolveOther('done');
    await expect(other).resolves.toBe('done');
    expect(tracker.size).toBe(0);
  });
});

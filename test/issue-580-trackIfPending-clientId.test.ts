/**
 * Tests for issue #580: InFlightTracker.trackIfPending missing clientId parameter.
 *
 * Fix: trackIfPending() now accepts an optional clientId (matching track())
 * and uses it both for the pending check and when re-tracking the operation,
 * so pending operations belonging to different clients never interfere.
 */

import { describe, it, expect, vi } from 'vitest';
import { InFlightTracker } from '../src/inFlightTracker';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('InFlightTracker.trackIfPending — clientId scoping (#580)', () => {
  it('returns the pending promise for the same clientId without running the operation', async () => {
    const tracker = new InFlightTracker();
    const original = deferred<string>();
    const tracked = tracker.track('1', 'check_in', () => original.promise, 'client-a');

    const followUp = vi.fn(async () => 'follow-up');
    const result = tracker.trackIfPending('1', 'check_in', followUp, 'client-a');

    expect(result).toBe(tracked);
    expect(followUp).not.toHaveBeenCalled();

    original.resolve('done');
    await expect(result).resolves.toBe('done');
  });

  it('returns undefined when only a different client has the operation pending', async () => {
    const tracker = new InFlightTracker();
    const original = deferred<string>();
    tracker.track('1', 'check_in', () => original.promise, 'client-a');

    const followUp = vi.fn(async () => 'follow-up');
    expect(tracker.trackIfPending('1', 'check_in', followUp, 'client-b')).toBeUndefined();
    expect(followUp).not.toHaveBeenCalled();
    expect(tracker.isInFlight('1', 'check_in', 'client-b')).toBe(false);

    original.resolve('done');
    await original.promise;
  });

  it('different clients with pending operations do not interfere with each other', async () => {
    const tracker = new InFlightTracker();
    const opA = deferred<string>();
    const opB = deferred<string>();
    const trackedA = tracker.track('1', 'check_in', () => opA.promise, 'client-a');
    const trackedB = tracker.track('1', 'check_in', () => opB.promise, 'client-b');

    expect(trackedA).not.toBe(trackedB);
    expect(tracker.trackIfPending('1', 'check_in', async () => 'x', 'client-a')).toBe(trackedA);
    expect(tracker.trackIfPending('1', 'check_in', async () => 'x', 'client-b')).toBe(trackedB);

    opA.resolve('a');
    await trackedA;

    // Client A's operation settled; client B's is still pending.
    expect(tracker.trackIfPending('1', 'check_in', async () => 'x', 'client-a')).toBeUndefined();
    expect(tracker.trackIfPending('1', 'check_in', async () => 'x', 'client-b')).toBe(trackedB);

    opB.resolve('b');
    await expect(trackedB).resolves.toBe('b');
  });

  it('does not match a client-scoped operation when called without clientId', async () => {
    const tracker = new InFlightTracker();
    const original = deferred<string>();
    tracker.track('1', 'check_in', () => original.promise, 'client-a');

    expect(tracker.trackIfPending('1', 'check_in', async () => 'x')).toBeUndefined();

    original.resolve('done');
    await original.promise;
  });

  it('remains backwards compatible when neither call passes clientId', async () => {
    const tracker = new InFlightTracker();
    const original = deferred<string>();
    const tracked = tracker.track('1', 'check_in', () => original.promise);

    expect(tracker.trackIfPending('1', 'check_in', async () => 'x')).toBe(tracked);

    original.resolve('done');
    await tracked;
    expect(tracker.trackIfPending('1', 'check_in', async () => 'x')).toBeUndefined();
  });
});

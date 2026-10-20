import { describe, expect, it } from 'vitest';

import { InFlightTracker, WalletConcurrencyLimitError } from '../src/inFlightTracker';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const WALLET_A = 'GAWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GBWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('#606 InFlightTracker per-wallet concurrency limits', () => {
  it('defaults to 10 concurrent operations per wallet', () => {
    expect(new InFlightTracker().walletLimit).toBe(10);
  });

  it('accepts a configurable max concurrent per wallet', () => {
    expect(new InFlightTracker({ maxConcurrentPerWallet: 3 }).walletLimit).toBe(3);
    expect(() => new InFlightTracker({ maxConcurrentPerWallet: 0 })).toThrow(RangeError);
  });

  it('rejects operations beyond the per-wallet limit', async () => {
    const tracker = new InFlightTracker({ maxConcurrentPerWallet: 2 });
    const gate = deferred();

    const p1 = tracker.track('1', 'check_in', () => gate.promise, undefined, WALLET_A);
    const p2 = tracker.track('2', 'check_in', () => gate.promise, undefined, WALLET_A);
    await expect(
      tracker.track('3', 'check_in', () => gate.promise, undefined, WALLET_A),
    ).rejects.toBeInstanceOf(WalletConcurrencyLimitError);
    expect(tracker.getWalletInFlightCount(WALLET_A)).toBe(2);

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(tracker.getWalletInFlightCount(WALLET_A)).toBe(0);
  });

  it('limits each wallet independently in multi-wallet scenarios', async () => {
    const tracker = new InFlightTracker({ maxConcurrentPerWallet: 1 });
    const gate = deferred();

    const a = tracker.track('1', 'check_in', () => gate.promise, undefined, WALLET_A);
    const b = tracker.track('2', 'check_in', () => gate.promise, undefined, WALLET_B);
    await expect(
      tracker.track('3', 'check_in', () => gate.promise, undefined, WALLET_A),
    ).rejects.toBeInstanceOf(WalletConcurrencyLimitError);
    await expect(
      tracker.track('4', 'check_in', () => gate.promise, undefined, WALLET_B),
    ).rejects.toBeInstanceOf(WalletConcurrencyLimitError);

    expect(tracker.getWalletInFlightCount(WALLET_A)).toBe(1);
    expect(tracker.getWalletInFlightCount(WALLET_B)).toBe(1);

    gate.resolve();
    await Promise.all([a, b]);
    await expect(
      tracker.track('3', 'check_in', () => Promise.resolve('ok'), undefined, WALLET_A),
    ).resolves.toBe('ok');
  });

  it('does not count deduplicated calls against the wallet', async () => {
    const tracker = new InFlightTracker({ maxConcurrentPerWallet: 1 });
    const gate = deferred<string>();

    const first = tracker.track('1', 'check_in', () => gate.promise, undefined, WALLET_A);
    const duplicate = tracker.track('1', 'check_in', () => gate.promise, undefined, WALLET_A);
    expect(duplicate).toBe(first);

    gate.resolve('done');
    await expect(duplicate).resolves.toBe('done');
  });

  it('frees wallet slots on abort and clear', () => {
    const tracker = new InFlightTracker({ maxConcurrentPerWallet: 2 });
    const never = (): Promise<never> => new Promise<never>(() => undefined);

    void tracker.track('1', 'check_in', never, undefined, WALLET_A);
    void tracker.track('2', 'check_in', never, undefined, WALLET_B);
    tracker.abort('1', 'check_in');
    expect(tracker.getWalletInFlightCount(WALLET_A)).toBe(0);

    tracker.clear();
    expect(tracker.getWalletInFlightCount(WALLET_B)).toBe(0);
  });
});

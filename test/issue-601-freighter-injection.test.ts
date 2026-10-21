import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const freighterApiMock = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  getAddress: vi.fn(),
  getNetworkDetails: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock('@stellar/freighter-api', () => ({
  default: freighterApiMock,
}));

import { FreighterNotAvailableError } from '../src/errors';
import { FreighterWalletAdapter, waitForFreighterInjection } from '../src/wallet';

const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('Freighter window injection race (#601)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    freighterApiMock.getAddress.mockReset().mockResolvedValue({ address: PUBLIC_KEY });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves immediately outside a browser', async () => {
    vi.unstubAllGlobals();
    await expect(waitForFreighterInjection(3, 10)).resolves.toBeUndefined();
  });

  it('resolves immediately when window.freighter is already injected', async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window.freighter = true;
    await expect(waitForFreighterInjection(3, 10)).resolves.toBeUndefined();
  });

  it('retries until Freighter injects window.stellar late', async () => {
    const adapter = new FreighterWalletAdapter({ injectionRetries: 5, injectionRetryDelayMs: 50 });
    const pending = adapter.getPublicKey();

    // Freighter injects after the second retry delay.
    await vi.advanceTimersByTimeAsync(100);
    (globalThis as unknown as { window: Record<string, unknown> }).window.stellar = {};
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBe(PUBLIC_KEY);
    expect(freighterApiMock.getAddress).toHaveBeenCalledTimes(1);
  });

  it('throws FreighterNotAvailableError when Freighter never injects', async () => {
    const adapter = new FreighterWalletAdapter({ injectionRetries: 3, injectionRetryDelayMs: 50 });
    const pending = adapter.getPublicKey();
    const assertion = expect(pending).rejects.toBeInstanceOf(FreighterNotAvailableError);

    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    await expect(pending).rejects.toMatchObject({ attempts: 3 });
    expect(freighterApiMock.getAddress).not.toHaveBeenCalled();
  });

  it('rejects invalid injection retry options', () => {
    expect(() => new FreighterWalletAdapter({ injectionRetries: 0 })).toThrow(RangeError);
    expect(() => new FreighterWalletAdapter({ injectionRetryDelayMs: -1 })).toThrow(RangeError);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  assertWalletSessionActive,
  WalletSessionError,
  WalletSessionExpiredError,
  type WalletAdapter,
  type WalletSession,
} from '../src/wallet';

const NOW = 1_700_000_000_000;

function makeWallet(overrides: Partial<WalletAdapter> = {}): WalletAdapter {
  return {
    isConnected: async () => true,
    connect: async () => ({ publicKey: 'GABC', network: 'testnet', networkPassphrase: 'pp' }),
    reconnect: async () => ({ publicKey: 'GABC', network: 'testnet', networkPassphrase: 'pp' }),
    disconnect: async () => {},
    getPublicKey: async () => 'GABC',
    signTransaction: async () => 'SIGNED',
    ...overrides,
  };
}

describe('Issue #600: wallet session expiration is validated before signing', () => {
  it('passes when the adapter does not expose sessions', async () => {
    await expect(assertWalletSessionActive(makeWallet(), NOW)).resolves.toBeUndefined();
  });

  it('passes when the session has no expiresAt', async () => {
    const wallet = makeWallet({ getSession: async () => ({ token: 't' }) });
    await expect(assertWalletSessionActive(wallet, NOW)).resolves.toBeUndefined();
  });

  it('passes when the session expires in the future', async () => {
    const wallet = makeWallet({ getSession: async () => ({ token: 't', expiresAt: NOW + 1 }) });
    await expect(assertWalletSessionActive(wallet, NOW)).resolves.toBeUndefined();
  });

  it('throws WalletSessionExpiredError when expired and the adapter cannot refresh', async () => {
    const wallet = makeWallet({ getSession: async () => ({ token: 't', expiresAt: NOW - 1 }) });

    const error = await assertWalletSessionActive(wallet, NOW).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WalletSessionExpiredError);
    expect(error).toBeInstanceOf(WalletSessionError);
    expect((error as WalletSessionExpiredError).expiresAt).toBe(NOW - 1);
    expect((error as Error).message).toMatch(/expired/i);
  });

  it('treats a session expiring exactly now as expired (edge case)', async () => {
    const wallet = makeWallet({ getSession: async () => ({ token: 't', expiresAt: NOW }) });
    await expect(assertWalletSessionActive(wallet, NOW)).rejects.toBeInstanceOf(
      WalletSessionExpiredError,
    );
  });

  it('refreshes an expired session when the adapter supports it', async () => {
    const refreshSession = vi.fn(async (): Promise<WalletSession> => ({ token: 't2', expiresAt: NOW + 60_000 }));
    const wallet = makeWallet({
      getSession: async () => ({ token: 't', expiresAt: NOW - 1 }),
      refreshSession,
    });

    await expect(assertWalletSessionActive(wallet, NOW)).resolves.toBeUndefined();
    expect(refreshSession).toHaveBeenCalledOnce();
  });

  it('throws when the refreshed session is still expired', async () => {
    const wallet = makeWallet({
      getSession: async () => ({ token: 't', expiresAt: NOW - 10 }),
      refreshSession: async () => ({ token: 't2', expiresAt: NOW - 1 }),
    });

    await expect(assertWalletSessionActive(wallet, NOW)).rejects.toBeInstanceOf(
      WalletSessionExpiredError,
    );
  });

  it('throws when refreshing the session fails', async () => {
    const cause = new Error('relay down');
    const wallet = makeWallet({
      getSession: async () => ({ token: 't', expiresAt: NOW - 1 }),
      refreshSession: async () => {
        throw cause;
      },
    });

    const error = await assertWalletSessionActive(wallet, NOW).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WalletSessionExpiredError);
    expect((error as Error).cause).toBe(cause);
  });
});

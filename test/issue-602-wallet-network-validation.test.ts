import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { SoroWillError, WalletNetworkMismatchError } from '../src/errors';
import type { WalletAdapter } from '../src/wallet';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function makeRpcServer(): SoroWillRpcServer {
  return {
    getContractWasmByContractId: vi.fn(),
    simulateTransaction: vi.fn(),
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    pollTransaction: vi.fn(),
  } as unknown as SoroWillRpcServer;
}

function makeWallet(networkPassphrase: string | undefined): WalletAdapter {
  const wallet: WalletAdapter = {
    isConnected: async () => true,
    connect: async () => ({ publicKey: PUBLIC_KEY, network: '', networkPassphrase: '' }),
    reconnect: async () => ({ publicKey: PUBLIC_KEY, network: '', networkPassphrase: '' }),
    disconnect: async () => {},
    getPublicKey: vi.fn(async () => PUBLIC_KEY),
    signTransaction: vi.fn(async (tx: string) => tx),
  };
  if (networkPassphrase !== undefined) {
    wallet.getNetwork = async () => ({ network: '', networkPassphrase });
  }
  return wallet;
}

describe('Wallet network validation (#602)', () => {
  it('rejects createWill before reading the wallet account when networks differ', async () => {
    const rpcServer = makeRpcServer();
    const wallet = makeWallet(Networks.PUBLIC);
    const client = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_ID, rpcServer, wallet });

    await expect(
      client.createWill({
        token: CONTRACT_ID,
        amount: '100',
        beneficiaries: [{ address: PUBLIC_KEY, percentage: 100 }],
        checkinPeriodDays: 30,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toBeInstanceOf(WalletNetworkMismatchError);

    expect(wallet.getPublicKey).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(rpcServer.getAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['checkIn', (c: SoroWillClient) => c.checkIn('1')],
    ['triggerWill', (c: SoroWillClient) => c.triggerWill('1')],
    ['cancelWill', (c: SoroWillClient) => c.cancelWill('1')],
    ['batch', (c: SoroWillClient) => c.batch([{ method: 'check_in', args: {} }])],
  ])('validates the wallet network before %s', async (_name, run) => {
    const wallet = makeWallet(Networks.PUBLIC);
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeRpcServer(),
      wallet,
    });

    await expect(run(client)).rejects.toBeInstanceOf(WalletNetworkMismatchError);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('names both networks in the mismatch error message', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeRpcServer(),
      wallet: makeWallet(Networks.PUBLIC),
    });

    const error = await client.assertWalletNetwork().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WalletNetworkMismatchError);
    expect((error as Error).name).toBe('WalletNetworkMismatchError');
    expect((error as Error).message).toContain('mainnet');
    expect((error as Error).message).toContain('testnet');
  });

  it('passes when the wallet is on the configured network', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeRpcServer(),
      wallet: makeWallet(Networks.TESTNET),
    });

    await expect(client.assertWalletNetwork()).resolves.toBeUndefined();
  });

  it('refuses wallets that cannot report a network when requireWalletNetwork is set', async () => {
    const lenient = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeRpcServer(),
      wallet: makeWallet(undefined),
    });
    await expect(lenient.assertWalletNetwork()).resolves.toBeUndefined();

    const strict = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeRpcServer(),
      wallet: makeWallet(undefined),
      requireWalletNetwork: true,
    });
    await expect(strict.assertWalletNetwork()).rejects.toBeInstanceOf(SoroWillError);
  });
});

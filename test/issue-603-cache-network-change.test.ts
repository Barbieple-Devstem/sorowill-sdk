import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ReadCache } from '../src/cache';
import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import type { WalletAdapter, WalletNetworkChangeListener } from '../src/wallet';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

describe('ReadCache network scoping (#603)', () => {
  it('keeps entries when the network is unchanged', () => {
    const cache = new ReadCache();
    expect(cache.setNetwork(Networks.TESTNET)).toBe(false);
    cache.set('k', 'v');

    expect(cache.setNetwork(Networks.TESTNET)).toBe(false);
    expect(cache.get('k')).toBe('v');
  });

  it('clears every entry when the network switches', () => {
    const cache = new ReadCache();
    cache.setNetwork(Networks.TESTNET);
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.setNetwork(Networks.PUBLIC)).toBe(true);
    expect(cache.getNetwork()).toBe(Networks.PUBLIC);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('SoroWillClient cache invalidation on network change (#603)', () => {
  function makeWallet(): { wallet: WalletAdapter; emit: WalletNetworkChangeListener; unsubscribe: ReturnType<typeof vi.fn> } {
    let registered: WalletNetworkChangeListener | undefined;
    const unsubscribe = vi.fn();
    const wallet: WalletAdapter = {
      isConnected: async () => true,
      connect: async () => ({ publicKey: PUBLIC_KEY, network: '', networkPassphrase: '' }),
      reconnect: async () => ({ publicKey: PUBLIC_KEY, network: '', networkPassphrase: '' }),
      disconnect: async () => {},
      getPublicKey: async () => PUBLIC_KEY,
      signTransaction: async (tx: string) => tx,
      onNetworkChange: (listener) => {
        registered = listener;
        return unsubscribe;
      },
    };
    return {
      wallet,
      emit: (network) => registered?.(network),
      unsubscribe,
    };
  }

  function makeClient(wallet: WalletAdapter): { client: SoroWillClient; cache: ReadCache } {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: {} as SoroWillRpcServer,
      wallet,
    });
    const cache = (client as unknown as { readCache: ReadCache }).readCache;
    return { client, cache };
  }

  it('registers a wallet network-change listener and scopes the cache to the configured network', () => {
    const { wallet } = makeWallet();
    const spy = vi.spyOn(wallet, 'onNetworkChange');
    const { cache } = makeClient(wallet);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(cache.getNetwork()).toBe(Networks.TESTNET);
  });

  it('clears cached reads when the wallet switches testnet → mainnet', () => {
    const { wallet, emit } = makeWallet();
    const { cache } = makeClient(wallet);
    cache.set('get_will:1', { id: '1' }, ['1']);

    emit({ network: 'PUBLIC', networkPassphrase: Networks.PUBLIC });

    expect(cache.get('get_will:1')).toBeUndefined();
    expect(cache.getNetwork()).toBe(Networks.PUBLIC);
  });

  it('clears cached reads again when switching back mainnet → testnet', () => {
    const { wallet, emit } = makeWallet();
    const { cache } = makeClient(wallet);

    emit({ network: 'PUBLIC', networkPassphrase: Networks.PUBLIC });
    cache.set('get_will:1', { id: '1' }, ['1']);
    emit({ network: 'TESTNET', networkPassphrase: Networks.TESTNET });

    expect(cache.get('get_will:1')).toBeUndefined();
  });

  it('handleNetworkChange is a no-op for the same network', () => {
    const { wallet } = makeWallet();
    const { client, cache } = makeClient(wallet);
    cache.set('k', 'v');

    expect(client.handleNetworkChange(Networks.TESTNET)).toBe(false);
    expect(cache.get('k')).toBe('v');
  });

  it('removes the listener on destroy()', () => {
    const { wallet, unsubscribe } = makeWallet();
    const { client } = makeClient(wallet);

    client.destroy();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

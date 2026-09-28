/**
 * Tests for issue #500: getNetworkFeeStats does not account for network
 * switching mid-session, returning mainnet fees when the user is on testnet.
 *
 * Fix: fee stats are cached per network passphrase. When the wallet reports a
 * different passphrase than the client was configured with (i.e. the user
 * switched networks in their wallet), the cache is flushed and fresh stats are
 * fetched from the RPC node.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { SoroWillClient } from '../src/SoroWillClient';
import type { SoroWillRpcServer } from '../src/SoroWillClient';
import type { WalletAdapter } from '../src/wallet';

// Minimal fee stats shape used in assertions.
const makeFeeStats = (maxFee: string) =>
  ({
    sorobanInclusionFee: { max: maxFee, min: '100', mode: '150', p10: '110', p20: '120', p30: '130', p40: '140', p50: '150', p60: '160', p70: '170', p80: '180', p90: '190', p95: '195', p99: '199', transactionCount: '10', ledgerCount: 5 },
    inclusionFee: { max: maxFee, min: '100', mode: '150', p10: '110', p20: '120', p30: '130', p40: '140', p50: '150', p60: '160', p70: '170', p80: '180', p90: '190', p95: '195', p99: '199', transactionCount: '10', ledgerCount: 5 },
    latestLedger: 1000,
  }) as unknown as import('@stellar/stellar-sdk').rpc.Api.GetFeeStatsResponse;

function makeRpcServer(feeStatsImpl: () => Promise<import('@stellar/stellar-sdk').rpc.Api.GetFeeStatsResponse>): SoroWillRpcServer {
  return {
    getContractWasmByContractId: vi.fn(),
    simulateTransaction: vi.fn(),
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    pollTransaction: vi.fn(),
    getFeeStats: vi.fn(feeStatsImpl),
  };
}

function makeWallet(networkPassphrase: string): WalletAdapter & { _network: { networkPassphrase: string } } {
  const wallet = {
    _network: { networkPassphrase },
    isConnected: vi.fn().mockResolvedValue(true),
    connect: vi.fn().mockResolvedValue({ publicKey: 'GABC', network: 'testnet', networkPassphrase }),
    reconnect: vi.fn().mockResolvedValue({ publicKey: 'GABC', network: 'testnet', networkPassphrase }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getPublicKey: vi.fn().mockResolvedValue('GABC'),
    signTransaction: vi.fn(),
    getNetwork: vi.fn().mockImplementation(() => Promise.resolve({ network: 'testnet', networkPassphrase: wallet._network.networkPassphrase })),
  };
  return wallet;
}

describe('issue #500 — getNetworkFeeStats per-network cache', () => {
  const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

  it('caches fee stats and returns the same result on a second call without hitting RPC again', async () => {
    const stats = makeFeeStats('5000');
    const getFeeStats = vi.fn().mockResolvedValue(stats);
    const server = makeRpcServer(getFeeStats);
    const wallet = makeWallet(Networks.TESTNET);

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet,
    });

    const result1 = await client.getNetworkFeeStats();
    const result2 = await client.getNetworkFeeStats();

    expect(result1).toBe(result2);
    // Should only have called the RPC once because the second call hit the cache.
    expect(getFeeStats).toHaveBeenCalledTimes(1);
  });

  it('flushes the cache and fetches fresh stats when the wallet switches to a different network', async () => {
    const testnetStats = makeFeeStats('1000');
    const mainnetStats = makeFeeStats('9999');

    let callCount = 0;
    const getFeeStats = vi.fn().mockImplementation(() => {
      callCount += 1;
      // First call: testnet stats; second call: mainnet stats.
      return Promise.resolve(callCount === 1 ? testnetStats : mainnetStats);
    });
    const server = makeRpcServer(getFeeStats);
    const wallet = makeWallet(Networks.TESTNET);

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet,
    });

    // First call — wallet is on testnet, should populate the testnet cache entry.
    const first = await client.getNetworkFeeStats();
    expect(first).toBe(testnetStats);
    expect(getFeeStats).toHaveBeenCalledTimes(1);

    // Simulate user switching their wallet to mainnet mid-session.
    wallet._network.networkPassphrase = Networks.PUBLIC;

    // Second call — wallet now reports mainnet passphrase which differs from the
    // client's configured testnet passphrase; cache must be flushed and RPC hit again.
    const second = await client.getNetworkFeeStats();
    expect(second).toBe(mainnetStats);
    expect(getFeeStats).toHaveBeenCalledTimes(2);
  });

  it('flushFeeStatsCache() clears the cache so the next call refetches from RPC', async () => {
    const stats = makeFeeStats('3000');
    const getFeeStats = vi.fn().mockResolvedValue(stats);
    const server = makeRpcServer(getFeeStats);
    const wallet = makeWallet(Networks.TESTNET);

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet,
    });

    await client.getNetworkFeeStats();
    expect(getFeeStats).toHaveBeenCalledTimes(1);

    client.flushFeeStatsCache();

    await client.getNetworkFeeStats();
    // Cache was flushed manually; should fetch again.
    expect(getFeeStats).toHaveBeenCalledTimes(2);
  });

  it('uses separate cache entries for testnet vs mainnet passphrases', async () => {
    const testnetStats = makeFeeStats('111');
    const mainnetStats = makeFeeStats('999');

    let callCount = 0;
    const getFeeStats = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(callCount % 2 === 1 ? testnetStats : mainnetStats);
    });
    const server = makeRpcServer(getFeeStats);
    const wallet = makeWallet(Networks.TESTNET);

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet,
    });

    // Populate testnet cache.
    const t1 = await client.getNetworkFeeStats();
    expect(t1).toBe(testnetStats);

    // Switch wallet to mainnet — old testnet cache is flushed, mainnet stats fetched.
    wallet._network.networkPassphrase = Networks.PUBLIC;
    const m1 = await client.getNetworkFeeStats();
    expect(m1).toBe(mainnetStats);

    // Both required RPC calls.
    expect(getFeeStats).toHaveBeenCalledTimes(2);

    // Another call with mainnet still selected should hit the mainnet cache.
    const m2 = await client.getNetworkFeeStats();
    expect(m2).toBe(mainnetStats);
    expect(getFeeStats).toHaveBeenCalledTimes(2); // no additional RPC call
  });

  it('falls back to the configured network passphrase when the wallet does not implement getNetwork()', async () => {
    const stats = makeFeeStats('500');
    const getFeeStats = vi.fn().mockResolvedValue(stats);
    const server = makeRpcServer(getFeeStats);

    // Wallet without getNetwork().
    const walletNoNetwork: WalletAdapter = {
      isConnected: vi.fn().mockResolvedValue(true),
      connect: vi.fn().mockResolvedValue({ publicKey: 'GABC', network: 'testnet', networkPassphrase: Networks.TESTNET }),
      reconnect: vi.fn().mockResolvedValue({ publicKey: 'GABC', network: 'testnet', networkPassphrase: Networks.TESTNET }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getPublicKey: vi.fn().mockResolvedValue('GABC'),
      signTransaction: vi.fn(),
      // No getNetwork property — intentionally omitted.
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet: walletNoNetwork,
    });

    const r1 = await client.getNetworkFeeStats();
    const r2 = await client.getNetworkFeeStats();

    expect(r1).toBe(stats);
    expect(r2).toBe(stats);
    // Should only hit RPC once — fell back to configured passphrase as cache key.
    expect(getFeeStats).toHaveBeenCalledTimes(1);
  });
});

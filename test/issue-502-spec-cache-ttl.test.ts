/**
 * Tests for issue #502: spec caching does not account for contract upgrades,
 * returning stale method signatures after a new contract version deploys.
 *
 * Fix: a TTL-based expiry (`specCacheTtlMs` option) clears the cached spec
 * promise once the TTL has elapsed so the next call transparently re-fetches
 * the WASM from the RPC node. The default TTL is Infinity (previous behaviour
 * preserved), and explicit `spec`/`specJson` overrides are never expired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { contract as stellarContract, Networks } from '@stellar/stellar-sdk';
import { SoroWillClient } from '../src/SoroWillClient';
import type { SoroWillRpcServer } from '../src/SoroWillClient';
import type { WalletAdapter } from '../src/wallet';

const { Spec } = stellarContract;

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

/** Minimal no-op spec double that satisfies the ContractSpecLike interface. */
function makeSpecDouble(tag: string) {
  return {
    tag,
    funcArgsToScVals: vi.fn().mockReturnValue([]),
    funcResToNative: vi.fn().mockReturnValue(null),
  };
}

function makeWallet(): WalletAdapter {
  return {
    isConnected: vi.fn().mockResolvedValue(true),
    connect: vi.fn().mockResolvedValue({ publicKey: 'GABC', network: 'testnet', networkPassphrase: Networks.TESTNET }),
    reconnect: vi.fn().mockResolvedValue({ publicKey: 'GABC', network: 'testnet', networkPassphrase: Networks.TESTNET }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getPublicKey: vi.fn().mockResolvedValue('GABC'),
    signTransaction: vi.fn(),
  };
}

describe('issue #502 — spec cache TTL for contract upgrades', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-fetches the spec after specCacheTtlMs has elapsed', async () => {
    const specV1 = makeSpecDouble('v1');
    const specV2 = makeSpecDouble('v2');

    let callCount = 0;
    const getContractWasm = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(Buffer.from('dummy-wasm'));
    });

    // Spy on Spec.fromWasm to return our doubles rather than trying to parse real WASM.
    const fromWasmSpy = vi.spyOn(Spec, 'fromWasm').mockImplementation(() => {
      return (callCount === 1 ? specV1 : specV2) as unknown as InstanceType<typeof Spec>;
    });

    const server: SoroWillRpcServer = {
      getContractWasmByContractId: getContractWasm,
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet: makeWallet(),
      // Expire the spec after 1 second.
      specCacheTtlMs: 1_000,
    });

    // Access private getSpec via cast — acceptable in unit tests.
    const getSpec = (client as unknown as { getSpec(): Promise<unknown> }).getSpec.bind(client);

    const first = await getSpec();
    expect(first).toBe(specV1);
    expect(getContractWasm).toHaveBeenCalledTimes(1);

    // Second call within TTL — should return cached spec without a new RPC call.
    const second = await getSpec();
    expect(second).toBe(specV1);
    expect(getContractWasm).toHaveBeenCalledTimes(1);

    // Advance time past the TTL.
    vi.advanceTimersByTime(1_001);

    // Third call after TTL expiry — spec must be re-fetched.
    const third = await getSpec();
    expect(third).toBe(specV2);
    expect(getContractWasm).toHaveBeenCalledTimes(2);

    fromWasmSpy.mockRestore();
  });

  it('never re-fetches when specCacheTtlMs is not set (default Infinity)', async () => {
    const getContractWasm = vi.fn().mockResolvedValue(Buffer.from('dummy-wasm'));
    const fromWasmSpy = vi.spyOn(Spec, 'fromWasm').mockReturnValue(
      makeSpecDouble('only-once') as unknown as InstanceType<typeof Spec>,
    );

    const server: SoroWillRpcServer = {
      getContractWasmByContractId: getContractWasm,
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet: makeWallet(),
      // No specCacheTtlMs — default Infinity.
    });

    const getSpec = (client as unknown as { getSpec(): Promise<unknown> }).getSpec.bind(client);

    await getSpec();
    // Advance by a large amount — default TTL is Infinity, so no re-fetch.
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    await getSpec();
    await getSpec();

    expect(getContractWasm).toHaveBeenCalledTimes(1);

    fromWasmSpy.mockRestore();
  });

  it('does not apply TTL when spec override is provided', async () => {
    const specOverride = makeSpecDouble('static-override');
    const getContractWasm = vi.fn();
    const fromWasmSpy = vi.spyOn(Spec, 'fromWasm');

    const server: SoroWillRpcServer = {
      getContractWasmByContractId: getContractWasm,
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet: makeWallet(),
      spec: specOverride as unknown as InstanceType<typeof Spec>,
      // Even a very short TTL must not cause a re-fetch when spec is overridden.
      specCacheTtlMs: 1,
    });

    const getSpec = (client as unknown as { getSpec(): Promise<unknown> }).getSpec.bind(client);

    const first = await getSpec();
    expect(first).toBe(specOverride);

    vi.advanceTimersByTime(1_000);

    const second = await getSpec();
    expect(second).toBe(specOverride);
    // RPC should never be called when spec is injected.
    expect(getContractWasm).not.toHaveBeenCalled();
    expect(fromWasmSpy).not.toHaveBeenCalled();

    fromWasmSpy.mockRestore();
  });

  it('refreshSpec() evicts the cache regardless of TTL', async () => {
    let callCount = 0;
    const getContractWasm = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(Buffer.from('wasm-v' + String(callCount)));
    });

    const specV1 = makeSpecDouble('v1');
    const specV2 = makeSpecDouble('v2');
    const fromWasmSpy = vi.spyOn(Spec, 'fromWasm').mockImplementation(() => {
      return (callCount === 1 ? specV1 : specV2) as unknown as InstanceType<typeof Spec>;
    });

    const server: SoroWillRpcServer = {
      getContractWasmByContractId: getContractWasm,
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
    };

    // Large TTL — refreshSpec should still force re-fetch.
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      wallet: makeWallet(),
      specCacheTtlMs: 60 * 60 * 1_000, // 1 hour
    });

    const getSpec = (client as unknown as { getSpec(): Promise<unknown> }).getSpec.bind(client);

    const first = await getSpec();
    expect(first).toBe(specV1);
    expect(getContractWasm).toHaveBeenCalledTimes(1);

    // refreshSpec() should clear the cache even though the TTL hasn't elapsed.
    await client.refreshSpec();
    const second = await getSpec();
    expect(second).toBe(specV2);
    expect(getContractWasm).toHaveBeenCalledTimes(2);

    fromWasmSpy.mockRestore();
  });

  it('throws RangeError for invalid specCacheTtlMs values', () => {
    const base = {
      network: 'testnet' as const,
      contractId: CONTRACT_ID,
      rpcServer: {
        getContractWasmByContractId: vi.fn(),
        simulateTransaction: vi.fn(),
        getAccount: vi.fn(),
        prepareTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        pollTransaction: vi.fn(),
      },
      wallet: makeWallet(),
    };

    expect(() => new SoroWillClient({ ...base, specCacheTtlMs: 0 })).toThrow(RangeError);
    expect(() => new SoroWillClient({ ...base, specCacheTtlMs: -1 })).toThrow(RangeError);
    expect(() => new SoroWillClient({ ...base, specCacheTtlMs: NaN })).toThrow(RangeError);
    // Infinity is explicitly allowed (default).
    expect(() => new SoroWillClient({ ...base, specCacheTtlMs: Infinity })).not.toThrow();
  });
});

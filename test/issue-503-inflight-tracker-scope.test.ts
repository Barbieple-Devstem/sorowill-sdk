/**
 * Tests for issue #503: request deduplication tracks by method name and args,
 * missing that different client instances make identical requests twice.
 *
 * Fix: InFlightTracker now accepts an optional scopeId (contract address)
 * that is included in the dedup key so that the same (willId, method) pair
 * on two different contracts is never mistaken for a duplicate. Additionally,
 * consumers can pass a shared InFlightTracker to two client instances targeting
 * the same contract to achieve true cross-instance deduplication.
 */

import { describe, it, expect, vi } from 'vitest';
import { InFlightTracker } from '../src/inFlightTracker';
import { SoroWillClient } from '../src/SoroWillClient';
import type { SoroWillRpcServer } from '../src/SoroWillClient';
import type { WalletAdapter } from '../src/wallet';
import { Networks } from '@stellar/stellar-sdk';

// ─── InFlightTracker unit tests ─────────────────────────────────────────────

describe('InFlightTracker — scopeId key isolation (#503)', () => {
  it('getKey() without scopeId produces willId:method format (backwards compatible)', () => {
    const tracker = new InFlightTracker();
    expect(tracker.getKey('42', 'check_in')).toBe('42:check_in');
    expect(tracker.getKey(99n, 'trigger_will')).toBe('99:trigger_will');
  });

  it('getKey() with scopeId prepends the scope separated by ::', () => {
    const tracker = new InFlightTracker('CONTRACT_A');
    expect(tracker.getKey('1', 'check_in')).toBe('CONTRACT_A::1:check_in');
  });

  it('two trackers with different scopeIds do not share in-flight state for the same willId+method', async () => {
    const trackerA = new InFlightTracker('CONTRACT_A');
    const trackerB = new InFlightTracker('CONTRACT_B');

    let resolveA!: () => void;
    let resolveB!: () => void;

    const promiseA = trackerA.track('1', 'check_in', () => new Promise<string>((r) => { resolveA = () => r('a'); }));
    const promiseB = trackerB.track('1', 'check_in', () => new Promise<string>((r) => { resolveB = () => r('b'); }));

    // Both operations must have been started (not deduplicated with each other).
    expect(trackerA.isInFlight('1', 'check_in')).toBe(true);
    expect(trackerB.isInFlight('1', 'check_in')).toBe(true);

    resolveA();
    resolveB();

    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    expect(resA).toBe('a');
    expect(resB).toBe('b');
  });

  it('a single tracker with one scopeId deduplicates calls for the same willId+method', async () => {
    const tracker = new InFlightTracker('SHARED_CONTRACT');
    let operationCallCount = 0;
    let resolveOp!: () => void;

    const op = (): Promise<string> => {
      operationCallCount += 1;
      return new Promise<string>((r) => { resolveOp = () => r('done'); });
    };

    const p1 = tracker.track('7', 'check_in', op);
    const p2 = tracker.track('7', 'check_in', op);

    // Second call should have been deduplicated — operation only started once.
    expect(operationCallCount).toBe(1);

    resolveOp();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('done');
    expect(r2).toBe('done');
  });

  it('two different methods for the same willId and scopeId are NOT deduplicated', async () => {
    const tracker = new InFlightTracker('CONTRACT');
    let resolveCheckin!: () => void;
    let resolveTrigger!: () => void;
    let checkinCalls = 0;
    let triggerCalls = 0;

    tracker.track('1', 'check_in', () => {
      checkinCalls += 1;
      return new Promise<void>((r) => { resolveCheckin = r; });
    });
    tracker.track('1', 'trigger_will', () => {
      triggerCalls += 1;
      return new Promise<void>((r) => { resolveTrigger = r; });
    });

    expect(checkinCalls).toBe(1);
    expect(triggerCalls).toBe(1);

    resolveCheckin();
    resolveTrigger();
  });

  it('clear() aborts all in-flight operations across any scopeId', async () => {
    const tracker = new InFlightTracker('MY_CONTRACT');
    let aborted = false;

    tracker.track('5', 'check_in', (signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise<void>(() => { /* never resolves */ });
    });

    tracker.clear();
    // Give the abort handler a microtask tick to run.
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(tracker.isInFlight('5', 'check_in')).toBe(false);
  });
});

// ─── SoroWillClient integration: default per-instance scoping ────────────────

const CONTRACT_A = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const CONTRACT_B = 'CBEZJYAQKRFBSF4XRCIJCQE4IJ2OF43N3VKXMYWZNLRJ5HKIPXV5NEQ';

function makeMinimalServer(): SoroWillRpcServer {
  return {
    getContractWasmByContractId: vi.fn(),
    simulateTransaction: vi.fn(),
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    pollTransaction: vi.fn(),
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

describe('SoroWillClient — default InFlightTracker scoped to contractId (#503)', () => {
  it('each client uses a tracker scoped to its own contractId by default', () => {
    const clientA = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_A,
      rpcServer: makeMinimalServer(),
      wallet: makeWallet(),
    });
    const clientB = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_B,
      rpcServer: makeMinimalServer(),
      wallet: makeWallet(),
    });

    // Access private inFlightTracker via cast for assertion.
    const trackerA = (clientA as unknown as { inFlightTracker: InFlightTracker }).inFlightTracker;
    const trackerB = (clientB as unknown as { inFlightTracker: InFlightTracker }).inFlightTracker;

    // Should be different instances (not shared by default).
    expect(trackerA).not.toBe(trackerB);

    // Keys should include the respective contractId so a collision is impossible.
    expect(trackerA.getKey('1', 'check_in')).toContain(CONTRACT_A);
    expect(trackerB.getKey('1', 'check_in')).toContain(CONTRACT_B);
    expect(trackerA.getKey('1', 'check_in')).not.toBe(trackerB.getKey('1', 'check_in'));
  });
});

describe('SoroWillClient — shared InFlightTracker for cross-instance dedup (#503)', () => {
  it('two clients sharing a tracker deduplicate identical in-flight operations', async () => {
    let resolveOp!: (value: string) => void;
    let operationCallCount = 0;

    // Build a server whose getContractWasmByContractId we can control.
    const server = makeMinimalServer();

    const sharedTracker = new InFlightTracker(CONTRACT_A);

    const clientA = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_A,
      rpcServer: server,
      wallet: makeWallet(),
      inFlightTracker: sharedTracker,
    });
    const clientB = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_A,
      rpcServer: server,
      wallet: makeWallet(),
      inFlightTracker: sharedTracker,
    });

    // Verify the same tracker instance is used by both clients.
    const tA = (clientA as unknown as { inFlightTracker: InFlightTracker }).inFlightTracker;
    const tB = (clientB as unknown as { inFlightTracker: InFlightTracker }).inFlightTracker;
    expect(tA).toBe(sharedTracker);
    expect(tB).toBe(sharedTracker);

    // Manually invoke the tracker to simulate two concurrent identical calls.
    const opFactory = (): Promise<string> => {
      operationCallCount += 1;
      return new Promise<string>((r) => { resolveOp = r; });
    };

    const p1 = sharedTracker.track('42', 'check_in', opFactory);
    const p2 = sharedTracker.track('42', 'check_in', opFactory);

    // Operation should only have been started once.
    expect(operationCallCount).toBe(1);

    resolveOp('result');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('result');
    expect(r2).toBe('result');
  });

  it('a shared tracker accepts a custom scopeId independent of the clients contractId', () => {
    const customTracker = new InFlightTracker('CUSTOM_SCOPE');
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_A,
      rpcServer: makeMinimalServer(),
      wallet: makeWallet(),
      inFlightTracker: customTracker,
    });

    const tracker = (client as unknown as { inFlightTracker: InFlightTracker }).inFlightTracker;
    expect(tracker).toBe(customTracker);
    expect(tracker.getKey('1', 'check_in')).toBe('CUSTOM_SCOPE::1:check_in');
  });
});

import { describe, expect, it, vi } from 'vitest';

import { ReadCache } from '../src/cache';
import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WillNotFoundError } from '../src/errors';
import type { BatchOperation } from '../src/types';
import type { WalletAdapter } from '../src/wallet';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

const wallet: WalletAdapter = {
  isConnected: async () => true,
  connect: async () => ({ publicKey: PUBLIC_KEY, network: '', networkPassphrase: '' }),
  reconnect: async () => ({ publicKey: PUBLIC_KEY, network: '', networkPassphrase: '' }),
  disconnect: async () => {},
  getPublicKey: async () => PUBLIC_KEY,
  signTransaction: async (tx: string) => tx,
};

const TEN_OPS: BatchOperation[] = Array.from({ length: 10 }, (_, i) => ({
  method: 'check_in',
  args: { will_id: String(i + 1) },
}));

type InvokeFn = (method: string, args: Record<string, unknown>) => Promise<{ txHash: string }>;

function makeClient(invoke: InvokeFn): { client: SoroWillClient; invokeSpy: ReturnType<typeof vi.fn> } {
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer: {} as SoroWillRpcServer,
    wallet,
  });
  const invokeSpy = vi.fn(invoke);
  (client as unknown as { invoke: InvokeFn }).invoke = invokeSpy;
  return { client, invokeSpy };
}

function failAt(failingWillId: string, error: () => Error = () => new Error('network blip')): InvokeFn {
  return async (_method, args) => {
    if (args.will_id === failingWillId) {
      throw error();
    }
    return { txHash: `tx-${String(args.will_id)}` };
  };
}

describe('batchSequential partial failure handling (#604)', () => {
  it('stops at the failed operation and marks the rest skipped by default', async () => {
    const { client, invokeSpy } = makeClient(failAt('5'));

    const result = await client.batchSequential(TEN_OPS);

    expect(result.success).toBe(false);
    expect(result.succeededCount).toBe(4);
    expect(result.failedCount).toBe(1);
    expect(result.skippedCount).toBe(5);
    expect(result.results.map((r) => r.status)).toEqual([
      'success', 'success', 'success', 'success',
      'failed',
      'skipped', 'skipped', 'skipped', 'skipped', 'skipped',
    ]);
    expect(result.results[4]!.error?.message).toBe('network blip');
    expect(result.results[5]!.error?.message).toContain('operation 4 (check_in) failed');
    expect(result.results[5]!.attempts).toBe(0);
    // Operations 6–10 were never submitted.
    expect(invokeSpy).toHaveBeenCalledTimes(5);
  });

  it("keeps going after a failure with onFailure: 'continue'", async () => {
    const { client, invokeSpy } = makeClient(failAt('5'));

    const result = await client.batchSequential(TEN_OPS, { onFailure: 'continue' });

    expect(result.succeededCount).toBe(9);
    expect(result.failedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.results[4]!.status).toBe('failed');
    expect(result.results[9]).toMatchObject({ status: 'success', txHash: 'tx-10' });
    expect(invokeSpy).toHaveBeenCalledTimes(10);
  });

  it('retries a transient failure and records the attempts', async () => {
    let calls = 0;
    const { client } = makeClient(async (_method, args) => {
      if (args.will_id === '5' && calls++ < 2) {
        throw new Error('transient');
      }
      return { txHash: `tx-${String(args.will_id)}` };
    });

    const result = await client.batchSequential(TEN_OPS, { maxRetries: 2 });

    expect(result.success).toBe(true);
    expect(result.results[4]).toMatchObject({ status: 'success', attempts: 3 });
  });

  it('does not retry deterministic contract errors', async () => {
    const { client, invokeSpy } = makeClient(failAt('5', () => new WillNotFoundError()));

    const result = await client.batchSequential(TEN_OPS, { maxRetries: 3 });

    expect(result.results[4]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(result.results[4]!.error).toBeInstanceOf(WillNotFoundError);
    expect(invokeSpy).toHaveBeenCalledTimes(5);
  });

  it('skips remaining operations once the signal is aborted', async () => {
    const controller = new AbortController();
    const { client } = makeClient(async (_method, args) => {
      if (args.will_id === '3') {
        controller.abort();
      }
      return { txHash: `tx-${String(args.will_id)}` };
    });

    const result = await client.batchSequential(TEN_OPS, { signal: controller.signal });

    expect(result.succeededCount).toBe(3);
    expect(result.skippedCount).toBe(7);
  });

  it('invalidates cached reads for every will in the queue', async () => {
    const { client } = makeClient(failAt('5'));
    const cache = (client as unknown as { readCache: ReadCache }).readCache;
    cache.set('will-5', { stale: true }, ['5']);
    cache.set('will-8', { stale: true }, ['8']);

    await client.batchSequential(TEN_OPS);

    expect(cache.get('will-5')).toBeUndefined();
    expect(cache.get('will-8')).toBeUndefined();
  });

  it('rejects an empty queue and invalid maxRetries', async () => {
    const { client } = makeClient(failAt('none'));

    await expect(client.batchSequential([])).rejects.toThrow(RangeError);
    await expect(client.batchSequential(TEN_OPS, { maxRetries: -1 })).rejects.toThrow(RangeError);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Account, Keypair } from '@stellar/stellar-sdk';

import { SoroWillClient } from '../src/SoroWillClient';
import { HookManager } from '../src/hooks';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function createClient(signTransaction: (xdr: string) => Promise<string>) {
  const publicKey = Keypair.random().publicKey();
  const rpcServer = {
    getAccount: vi.fn(async () => new Account(publicKey, '1')),
    prepareTransaction: vi.fn(async (tx: unknown) => tx),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'TX_HASH' })),
    pollTransaction: vi.fn(async () => ({ status: 'SUCCESS', createdAt: 1, returnValue: undefined })),
    simulateTransaction: vi.fn(),
    getContractWasmByContractId: vi.fn(),
  };
  const hooks = new HookManager();
  const afterInvoke = vi.fn();
  hooks.onAfterInvoke(afterInvoke);

  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer: rpcServer as never,
    readCache: false,
    hooks,
    spec: { funcArgsToScVals: () => [], funcResToNative: () => undefined } as never,
    wallet: {
      getPublicKey: async () => publicKey,
      signTransaction: vi.fn(signTransaction),
    } as never,
  });
  return { client, rpcServer, afterInvoke };
}

const hangForever = (): Promise<string> => new Promise<string>(() => undefined);

describe('#608 SoroWillClient in-flight operation cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const { client, rpcServer } = createClient(hangForever);
    const controller = new AbortController();
    controller.abort();

    await expect(client.triggerWill('1', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(rpcServer.getAccount).not.toHaveBeenCalled();
  });

  it('aborts an operation before completion via AbortSignal', async () => {
    const { client, rpcServer, afterInvoke } = createClient(hangForever);
    const controller = new AbortController();

    const pending = client.triggerWill('1', { signal: controller.signal });
    await vi.waitFor(() => expect(rpcServer.prepareTransaction).toHaveBeenCalled());

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled();

    // Graceful cleanup: afterInvoke hooks still observe the aborted call.
    await vi.waitFor(() =>
      expect(afterInvoke).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'trigger_will', txHash: null, error: expect.any(String) }),
      ),
    );
  });

  it('cancels a tracked operation through cancelOperation()', async () => {
    const { client, rpcServer } = createClient(hangForever);

    expect(client.cancelOperation('1', 'trigger_will')).toBe(false);

    const pending = client.triggerWill('1');
    await vi.waitFor(() => expect(rpcServer.prepareTransaction).toHaveBeenCalled());

    expect(client.cancelOperation('1', 'trigger_will')).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled();
  });

  it('allows a fresh operation after an aborted one', async () => {
    let calls = 0;
    const { client } = createClient(async (xdr) => {
      calls += 1;
      return calls === 1 ? hangForever() : xdr;
    });
    const controller = new AbortController();

    const first = client.triggerWill('1', { signal: controller.signal });
    await vi.waitFor(() => expect(calls).toBe(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    await expect(client.triggerWill('1')).resolves.toEqual({ txHash: 'TX_HASH' });
  });
});

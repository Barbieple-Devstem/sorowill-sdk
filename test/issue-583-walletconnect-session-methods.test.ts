import { describe, expect, it, vi } from 'vitest';

import {
  WalletConnectAdapter,
  WalletConnectUnsupportedMethodError,
  type WalletConnectClient,
  type WalletConnectSession,
} from '../src/walletConnect';

function makeSession(methods?: string[]): WalletConnectSession {
  return {
    topic: 'topic-583',
    namespaces: {
      stellar: {
        accounts: ['stellar:testnet:GABC123'],
        ...(methods ? { methods } : {}),
        events: [],
      },
    },
  };
}

function makeClient(session: WalletConnectSession) {
  const request = vi.fn(async () => 'SIGNED_XDR');
  const client: WalletConnectClient = {
    async connect() {
      return {
        async approval() {
          return session;
        },
      };
    },
    async disconnect() {},
    async getSession(topic) {
      return topic === session.topic ? session : null;
    },
    request: request as WalletConnectClient['request'],
  };
  return { client, request };
}

describe('Issue #583: WalletConnectAdapter validates session namespace methods', () => {
  it('rejects a session whose namespace has no methods array', async () => {
    const { client } = makeClient(makeSession());
    const adapter = new WalletConnectAdapter(client);

    await expect(adapter.connect()).rejects.toBeInstanceOf(WalletConnectUnsupportedMethodError);
    await expect(adapter.isConnected()).resolves.toBe(false);
  });

  it('rejects a session whose namespace has an empty methods array', async () => {
    const { client } = makeClient(makeSession([]));
    const adapter = new WalletConnectAdapter(client);

    await expect(adapter.connect()).rejects.toThrow('does not declare any supported methods');
  });

  it('rejects a session that does not include the configured signTransactionMethod', async () => {
    const { client } = makeClient(makeSession(['stellar_signXDR']));
    const adapter = new WalletConnectAdapter(client, {
      signTransactionMethod: 'stellar_signAndSubmitXDR',
    });

    const error = await adapter.connect().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WalletConnectUnsupportedMethodError);
    expect((error as WalletConnectUnsupportedMethodError).method).toBe('stellar_signAndSubmitXDR');
    expect((error as WalletConnectUnsupportedMethodError).supportedMethods).toEqual(['stellar_signXDR']);
  });

  it('accepts the signing method case-insensitively', async () => {
    const { client } = makeClient(makeSession(['stellar_signXdr']));
    const adapter = new WalletConnectAdapter(client);

    await expect(adapter.connect()).resolves.toMatchObject({ publicKey: 'GABC123' });
  });

  it('does not send a signing request when a restored session lacks the method', async () => {
    const session = makeSession([]);
    const { client, request } = makeClient(session);
    const adapter = new WalletConnectAdapter(client);
    // Simulate a previously persisted topic without going through connect().
    await (adapter as unknown as { sessionStore: { setSessionTopic(t: string): Promise<void> } })
      .sessionStore.setSessionTopic(session.topic);

    await expect(adapter.signTransaction('XDR')).rejects.toBeInstanceOf(
      WalletConnectUnsupportedMethodError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});

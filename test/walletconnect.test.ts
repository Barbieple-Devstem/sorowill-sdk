import { describe, expect, it, vi } from 'vitest';

import {
  LocalStorageWalletConnectSessionStore,
  MemoryWalletConnectSessionStore,
  WalletConnectAdapter,
  WalletConnectTimeoutError,
  type WalletConnectClient,
  type WalletConnectSession,
} from '../src/walletConnect';

function makeSession(topic = 'topic-1'): WalletConnectSession {
  return {
    topic,
    namespaces: {
      stellar: {
        accounts: ['stellar:testnet:GABC123'],
        methods: ['stellar_signXdr'],
        events: [],
      },
    },
  };
}

describe('WalletConnectAdapter', () => {
  it('persists session topics through the localStorage store', async () => {
    const storage = new Map<string, string>();
    const store = new LocalStorageWalletConnectSessionStore({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    } as Storage);

    await store.setSessionTopic('topic-local');
    await expect(store.getSessionTopic()).resolves.toBe('topic-local');
    await store.clearSessionTopic();
    await expect(store.getSessionTopic()).resolves.toBeNull();
  });

  it('connects, signs, and disconnects through the generic WalletConnect client', async () => {
    const session = makeSession();
    let disconnectedTopic: string | null = null;

    const client: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:test',
          async approval() {
            return session;
          },
        };
      },
      async disconnect(options) {
        disconnectedTopic = options.topic;
      },
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>(_options: {
        topic: string;
        chainId: string;
        request: { method: string; params: unknown };
      }) {
        return { signedTxXdr: 'SIGNED_XDR' } as T;
      },
    };

    const adapter = new WalletConnectAdapter(client, {
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    const connection = await adapter.connect();
    expect(connection.publicKey).toBe('GABC123');
    expect(connection.network).toBe('testnet');
    expect(await adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: connection.networkPassphrase })).toBe(
      'SIGNED_XDR',
    );

    await adapter.disconnect();
    expect(disconnectedTopic).toBe(session.topic);
    expect(await adapter.isConnected()).toBe(false);
  });

  it('throws when signTransaction networkPassphrase does not match session network', async () => {
    const session = makeSession();
    const client: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:test',
          async approval() {
            return session;
          },
        };
      },
      async disconnect() {
        return;
      },
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>() {
        return { signedTxXdr: 'SIGNED_XDR' } as T;
      },
    };

    const adapter = new WalletConnectAdapter(client, {
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    await adapter.connect();

    await expect(
      adapter.signTransaction('UNSIGNED_XDR', {
        networkPassphrase: 'Public Global Stellar Network ; September 2015'
      }),
    ).rejects.toThrow('WalletConnect session is connected to');
  });

  it('selects Stellar account from multi-namespace session', async () => {
    const multiNamespaceSession: WalletConnectSession = {
      topic: 'topic-1',
      namespaces: {
        eip155: {
          accounts: ['eip155:1:0x1234567890123456789012345678901234567890'],
          methods: ['eth_sign'],
          events: [],
        },
        stellar: {
          accounts: ['stellar:testnet:GABC123'],
          methods: ['stellar_signXdr'],
          events: [],
        },
      },
    };

    const client: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:test',
          async approval() {
            return multiNamespaceSession;
          },
        };
      },
      async disconnect() {
        return;
      },
      async getSession(topic) {
        return topic === multiNamespaceSession.topic ? multiNamespaceSession : null;
      },
      async request<T>() {
        return { signedTxXdr: 'SIGNED_XDR' } as T;
      },
    };

    const adapter = new WalletConnectAdapter(client, {
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    await adapter.connect();
    const publicKey = await adapter.getPublicKey();
    const network = await adapter.getNetwork();

    expect(publicKey).toBe('GABC123');
    expect(network.network).toBe('testnet');
  });

  it('reconnects from a stored session topic', async () => {
    const session = makeSession('topic-2');
    const store = new MemoryWalletConnectSessionStore();
    await store.setSessionTopic(session.topic);

    const client: WalletConnectClient = {
      async connect() {
        throw new Error('connect should not be called during reconnect');
      },
      async disconnect() {
        return;
      },
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>(_options: {
        topic: string;
        chainId: string;
        request: { method: string; params: unknown };
      }) {
        return 'SIGNED_XDR' as T;
      },
    };

    const adapter = new WalletConnectAdapter(client, { sessionStore: store });
    const connection = await adapter.reconnect();

    expect(connection.publicKey).toBe('GABC123');
    expect(await adapter.getPublicKey()).toBe('GABC123');
  });

  it('reconnect throws when no session topic is stored', async () => {
    const store = new MemoryWalletConnectSessionStore();
    const client: WalletConnectClient = {
      async connect() {
        throw new Error('connect should not be called');
      },
      async disconnect() {
        return;
      },
      async getSession() {
        throw new Error('getSession should not be called');
      },
      async request() {
        throw new Error('request should not be called');
      },
    };

    const adapter = new WalletConnectAdapter(client, { sessionStore: store });
    await expect(adapter.reconnect()).rejects.toThrow('No WalletConnect session topic is stored');
  });

  it('reconnect clears stored topic when session no longer exists', async () => {
    const store = new MemoryWalletConnectSessionStore();
    await store.setSessionTopic('stale-topic');

    const client: WalletConnectClient = {
      async connect() {
        throw new Error('connect should not be called');
      },
      async disconnect() {
        return;
      },
      async getSession() {
        return null;
      },
      async request() {
        throw new Error('request should not be called');
      },
    };

    const adapter = new WalletConnectAdapter(client, { sessionStore: store });
    await expect(adapter.reconnect()).rejects.toThrow('Stored WalletConnect session no longer exists');
    expect(await store.getSessionTopic()).toBeNull();
  });

  it('disconnect is a no-op when never connected', async () => {
    const client: WalletConnectClient = {
      async connect() {
        throw new Error('connect should not be called');
      },
      async disconnect() {
        throw new Error('disconnect should not be called on client');
      },
      async getSession() {
        throw new Error('getSession should not be called');
      },
      async request() {
        throw new Error('request should not be called');
      },
    };

    const adapter = new WalletConnectAdapter(client);
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(await adapter.isConnected()).toBe(false);
  });
});

describe('WalletConnectAdapter defaults and network resolution', () => {
  function makeClient(session: WalletConnectSession, response: unknown) {
    const calls: Array<{ requiredNamespaces?: unknown; request?: unknown; chainId?: string }> = [];
    const client: WalletConnectClient = {
      async connect(options) {
        calls.push({ requiredNamespaces: options.requiredNamespaces });
        return { uri: 'wc:test', approval: async () => session };
      },
      async disconnect() {},
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>(options: { topic: string; chainId: string; request: { method: string; params: unknown } }) {
        calls.push({ request: options.request, chainId: options.chainId });
        return response as T;
      },
    };
    return { client, calls };
  }

  it('requests pubnet and testnet with the documented method and parses signedXDR', async () => {
    const { client, calls } = makeClient(makeSession(), { signedXDR: 'SIGNED_DOC_XDR' });
    const adapter = new WalletConnectAdapter(client);

    const connection = await adapter.connect();
    const signed = await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: connection.networkPassphrase,
    });

    expect(calls[0]!.requiredNamespaces).toEqual({
      stellar: { methods: ['stellar_signXDR'], chains: ['stellar:pubnet', 'stellar:testnet'], events: [] },
    });
    expect(calls[1]!.request).toEqual({ method: 'stellar_signXDR', params: { xdr: 'UNSIGNED_XDR' } });
    expect(signed).toBe('SIGNED_DOC_XDR');
  });

  it('keeps the legacy request shape available through override options', async () => {
    const { client, calls } = makeClient(makeSession(), { signedTxXdr: 'SIGNED_LEGACY' });
    const adapter = new WalletConnectAdapter(client, {
      signTransactionMethod: 'stellar_signXdr',
      getSignTransactionParams: (transactionXdr, networkPassphrase) => ({ transactionXdr, networkPassphrase }),
    });

    const connection = await adapter.connect();
    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: connection.networkPassphrase }),
    ).resolves.toBe('SIGNED_LEGACY');
    expect(calls[1]!.request).toEqual({
      method: 'stellar_signXdr',
      params: { transactionXdr: 'UNSIGNED_XDR', networkPassphrase: connection.networkPassphrase },
    });
  });

  it('signs on a custom chain using the configured network and networkPassphrase', async () => {
    const session = makeSession();
    session.namespaces!.stellar!.accounts = ['stellar:futurenet:GABC123'];
    const { client } = makeClient(session, { signedXDR: 'SIGNED_CUSTOM' });
    const adapter = new WalletConnectAdapter(client, {
      network: 'futurenet',
      networkPassphrase: 'Test SDF Future Network ; October 2022',
    });

    await adapter.connect();
    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Test SDF Future Network ; October 2022' }),
    ).resolves.toBe('SIGNED_CUSTOM');
    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).rejects.toThrow('but transaction is for a different network');
  });
});

describe('LocalStorageWalletConnectSessionStore', () => {
  it('getSessionTopic returns stored topic', async () => {
    const mockStorage = {
      getItem: (key: string) => (key === 'test-key' ? 'stored-topic' : null),
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    } as Storage;

    const store = new LocalStorageWalletConnectSessionStore(mockStorage, 'test-key');
    const topic = await store.getSessionTopic();
    expect(topic).toBe('stored-topic');
  });

  it('getSessionTopic returns null when no topic is stored', async () => {
    const mockStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    } as Storage;

    const store = new LocalStorageWalletConnectSessionStore(mockStorage, 'test-key');
    const topic = await store.getSessionTopic();
    expect(topic).toBeNull();
  });

  it('setSessionTopic stores the topic', async () => {
    let storedValue: string | null = null;
    const mockStorage = {
      getItem: (key: string) => (key === 'test-key' ? storedValue : null),
      setItem: (key: string, value: string) => {
        if (key === 'test-key') {
          storedValue = value;
        }
      },
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    } as Storage;

    const store = new LocalStorageWalletConnectSessionStore(mockStorage, 'test-key');
    await store.setSessionTopic('new-topic');

    const topic = await store.getSessionTopic();
    expect(topic).toBe('new-topic');
  });

  it('clearSessionTopic removes the stored topic', async () => {
    let storedValue: string | null = 'initial-topic';
    const mockStorage = {
      getItem: (key: string) => (key === 'test-key' ? storedValue : null),
      setItem: (key: string, value: string) => {
        if (key === 'test-key') {
          storedValue = value;
        }
      },
      removeItem: (key: string) => {
        if (key === 'test-key') {
          storedValue = null;
        }
      },
      clear: () => {},
      length: 0,
      key: () => null,
    } as Storage;

    const store = new LocalStorageWalletConnectSessionStore(mockStorage, 'test-key');
    expect(await store.getSessionTopic()).toBe('initial-topic');

    await store.clearSessionTopic();
    expect(await store.getSessionTopic()).toBeNull();
  });

  it('uses default key when not specified', async () => {
    let storedValue: string | null = null;
    let setKeyUsed: string | null = null;
    const mockStorage = {
      getItem: (key: string) => (key === 'sorowill:walletconnect:session-topic' ? storedValue : null),
      setItem: (key: string, value: string) => {
        if (key === 'sorowill:walletconnect:session-topic') {
          setKeyUsed = key;
          storedValue = value;
        }
      },
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    } as Storage;

    const store = new LocalStorageWalletConnectSessionStore(mockStorage);
    await store.setSessionTopic('default-key-topic');

    expect(setKeyUsed).toBe('sorowill:walletconnect:session-topic');
    expect(await store.getSessionTopic()).toBe('default-key-topic');
  });
});

// ---------------------------------------------------------------------------
// Issue #498 — WalletConnect connection timeout
// ---------------------------------------------------------------------------
describe('WalletConnectAdapter – connection timeout', () => {
  it('throws WalletConnectTimeoutError when approval hangs beyond connectionTimeoutMs', async () => {
    vi.useFakeTimers();

    let disconnectCalled = false;
    const hangingClient: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:test',
          // This promise never resolves, simulating a wallet that does not respond.
          approval(): Promise<WalletConnectSession> {
            return new Promise(() => {
              /* intentionally never resolves */
            });
          },
        };
      },
      async disconnect() {
        disconnectCalled = true;
      },
      async getSession() {
        return null;
      },
      async request() {
        throw new Error('should not be called');
      },
    };

    const adapter = new WalletConnectAdapter(hangingClient, {
      connectionTimeoutMs: 5_000,
    });

    const connectPromise = adapter.connect();

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(connectPromise).rejects.toThrow(WalletConnectTimeoutError);

    vi.useRealTimers();
  });

  it('WalletConnectTimeoutError carries the configured timeoutMs', async () => {
    vi.useFakeTimers();

    const hangingClient: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:test',
          approval(): Promise<WalletConnectSession> {
            return new Promise(() => {/* never resolves */});
          },
        };
      },
      async disconnect() {},
      async getSession() { return null; },
      async request() { throw new Error('unreachable'); },
    };

    const adapter = new WalletConnectAdapter(hangingClient, {
      connectionTimeoutMs: 10_000,
    });

    const connectPromise = adapter.connect();
    await vi.advanceTimersByTimeAsync(11_000);

    try {
      await connectPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(WalletConnectTimeoutError);
      expect(err.timeoutMs).toBe(10_000);
      expect(err.message).toContain('10000ms');
    }

    vi.useRealTimers();
  });

  it('cleans up (calls disconnect) when the connection times out', async () => {
    vi.useFakeTimers();

    let disconnectCalledWithReason: { code: number; message: string } | undefined;
    const hangingClient: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:test',
          approval(): Promise<WalletConnectSession> {
            return new Promise(() => {/* never resolves */});
          },
        };
      },
      async disconnect(options) {
        disconnectCalledWithReason = options.reason;
      },
      async getSession() { return null; },
      async request() { throw new Error('unreachable'); },
    };

    const adapter = new WalletConnectAdapter(hangingClient, {
      connectionTimeoutMs: 3_000,
    });

    const connectPromise = adapter.connect();
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(connectPromise).rejects.toBeInstanceOf(WalletConnectTimeoutError);
    // Resources should have been cleaned up
    expect(disconnectCalledWithReason).toBeDefined();
    expect(disconnectCalledWithReason?.code).toBe(6001);

    vi.useRealTimers();
  });

  it('succeeds normally when approval resolves before the timeout', async () => {
    vi.useFakeTimers();

    const session = {
      topic: 'topic-fast',
      namespaces: {
        stellar: {
          accounts: ['stellar:testnet:GFASTACCOUNT'],
          methods: ['stellar_signXdr'],
          events: [],
        },
      },
    };

    const fastClient: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:fast',
          async approval() {
            return session;
          },
        };
      },
      async disconnect() {},
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>() {
        return { signedTxXdr: 'SIGNED_XDR' } as T;
      },
    };

    const adapter = new WalletConnectAdapter(fastClient, {
      connectionTimeoutMs: 30_000,
    });

    const connectPromise = adapter.connect();
    // Don't advance time – the approval resolves synchronously in our mock
    const connection = await connectPromise;

    expect(connection.publicKey).toBe('GFASTACCOUNT');

    vi.useRealTimers();
  });

  it('uses a default timeout of 30 seconds when connectionTimeoutMs is not set', async () => {
    vi.useFakeTimers();

    const hangingClient: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:test',
          approval(): Promise<WalletConnectSession> {
            return new Promise(() => {/* never resolves */});
          },
        };
      },
      async disconnect() {},
      async getSession() { return null; },
      async request() { throw new Error('unreachable'); },
    };

    // No connectionTimeoutMs → should use the 30 s default
    const adapter = new WalletConnectAdapter(hangingClient);
    const connectPromise = adapter.connect();

    await vi.advanceTimersByTimeAsync(31_000);

    await expect(connectPromise).rejects.toBeInstanceOf(WalletConnectTimeoutError);

    vi.useRealTimers();
  });

  it('disables the timeout when connectionTimeoutMs is 0', async () => {
    vi.useFakeTimers();

    let approveResolve: (session: WalletConnectSession) => void;
    const session = {
      topic: 'topic-slow',
      namespaces: {
        stellar: {
          accounts: ['stellar:testnet:GSLOWACCOUNT'],
          methods: ['stellar_signXdr'],
          events: [],
        },
      },
    };

    const slowClient: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:slow',
          approval(): Promise<WalletConnectSession> {
            return new Promise((resolve) => {
              approveResolve = resolve;
            });
          },
        };
      },
      async disconnect() {},
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>() {
        return { signedTxXdr: 'SIGNED_XDR' } as T;
      },
    };

    const adapter = new WalletConnectAdapter(slowClient, { connectionTimeoutMs: 0 });
    const connectPromise = adapter.connect();

    // Advance well past any default timeout — should not throw
    await vi.advanceTimersByTimeAsync(60_000);

    // Now resolve manually — should succeed without an error
    approveResolve!(session);
    const connection = await connectPromise;
    expect(connection.publicKey).toBe('GSLOWACCOUNT');

    vi.useRealTimers();
  });
});

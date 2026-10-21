import { SignTransactionTimeoutError } from './errors';
import type { WalletAdapter, WalletConnection, SignTransactionOptions } from './wallet';

export interface WalletConnectSessionNamespace {
  accounts?: string[];
  chains?: string[];
  methods?: string[];
  events?: string[];
}

export interface WalletConnectSession {
  topic: string;
  namespaces?: Record<string, WalletConnectSessionNamespace>;
  sessionProperties?: Record<string, string>;
}

export interface WalletConnectConnectResult {
  uri?: string;
  approval(): Promise<WalletConnectSession>;
}

export interface WalletConnectClient {
  connect(options: {
    requiredNamespaces: Record<string, WalletConnectSessionNamespace>;
    optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
    pairingTopic?: string;
  }): Promise<WalletConnectConnectResult>;
  disconnect(options: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  getSession(topic: string): Promise<WalletConnectSession | null> | WalletConnectSession | null;
  request<T>(options: {
    topic: string;
    chainId: string;
    request: {
      method: string;
      params: unknown;
    };
  }): Promise<T>;
}

export interface WalletConnectSessionStore {
  getSessionTopic(): Promise<string | null> | string | null;
  setSessionTopic(topic: string): Promise<void> | void;
  clearSessionTopic(): Promise<void> | void;
}

/**
 * Shape returned by WalletConnect wallets for `stellar_signXdr`.
 * Wallets return a `SignedTransaction` object rather than a bare XDR string,
 * so the adapter must validate and unwrap it before handing it downstream.
 */
export interface SignatureResponse {
  envelope_xdr: string;
  hash?: string;
}

export interface WalletConnectAdapterOptions {
  requiredNamespaces?: Record<string, WalletConnectSessionNamespace>;
  optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
  pairingTopic?: string;
  network?: string;
  networkPassphrase?: string;
  requestChainId?: string;
  /** Defaults to `stellar_signXDR`, per the WalletConnect Stellar namespace documentation. */
  signTransactionMethod?: string;
  /**
   * Builds the signing request params. Defaults to `{ xdr }`, per the WalletConnect
   * Stellar namespace documentation.
   */
  getSignTransactionParams?(transactionXdr: string, networkPassphrase: string): unknown;
  disconnectReason?: { code: number; message: string };
  sessionStore?: WalletConnectSessionStore;
  /**
   * Milliseconds to wait for the relay to return a signed transaction before
   * rejecting with {@link SignTransactionTimeoutError}. Defaults to 120000.
   * Used when the mobile wallet fails to respond — either backgrounded, inactive,
   * or experiencing relay message loss.
   */
  timeoutMs?: number;
  /**
   * Milliseconds to wait for the wallet to approve the pairing in {@link WalletConnectAdapter.connect}
   * before rejecting. Defaults to 300000.
   */
  connectTimeoutMs?: number;
  onPairingUri?(uri: string): void | Promise<void>;
  getPublicKeyFromSession?(session: WalletConnectSession): string;
  getNetworkFromSession?(session: WalletConnectSession): { network: string; networkPassphrase: string };
  getSignedTransactionXdr?(response: unknown): string;
  /**
   * Maximum time in milliseconds to wait for the wallet to approve a
   * WalletConnect session.  If `connection.approval()` does not resolve
   * within this window the pending connection is cleaned up and
   * {@link WalletConnectTimeoutError} is thrown.
   *
   * Defaults to **30 000 ms** (30 seconds).  Set to `0` to disable the
   * timeout entirely (not recommended for production use).
   */
  connectionTimeoutMs?: number;
}

const DEFAULT_REQUIRED_NAMESPACES: Record<string, WalletConnectSessionNamespace> = {
  stellar: {
    methods: ['stellar_signXDR'],
    chains: ['stellar:pubnet', 'stellar:testnet'],
    events: [],
  },
};

const DEFAULT_SIGN_TRANSACTION_METHOD = 'stellar_signXDR';
const DEFAULT_DISCONNECT_REASON = { code: 6000, message: 'Disconnected by client' };
const _DEFAULT_SIGN_TIMEOUT_MS = 120_000;
const _DEFAULT_CONNECT_TIMEOUT_MS = 300_000;

/**
 * Raised when a WalletConnect session establishment does not complete within
 * the configured {@link WalletConnectAdapterOptions.connectionTimeoutMs} window.
 *
 * When this error is thrown the adapter cleans up any in-progress pairing so
 * the application is not left in an indeterminate state.
 */
export class WalletConnectTimeoutError extends Error {
  /** The timeout value (in milliseconds) that was exceeded. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(
      `WalletConnect session approval timed out after ${timeoutMs}ms. ` +
        'The wallet did not respond in time. Please try connecting again.',
      options,
    );
    this.name = 'WalletConnectTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Raised when a WalletConnect session does not advertise support for the
 * signing method the adapter needs (see
 * {@link WalletConnectAdapterOptions.signTransactionMethod}). Detecting this
 * at connection time avoids sending requests the wallet will reject.
 */
export class WalletConnectUnsupportedMethodError extends Error {
  /** The signing method the adapter requires. */
  readonly method: string;
  /** The methods advertised by the wallet's session namespaces. */
  readonly supportedMethods: string[];

  constructor(method: string, supportedMethods: string[], options?: ErrorOptions) {
    super(
      supportedMethods.length === 0
        ? `WalletConnect session does not declare any supported methods; "${method}" is required.`
        : `WalletConnect session does not support required method "${method}". ` +
            `Supported methods: ${supportedMethods.join(', ')}`,
      options,
    );
    this.name = 'WalletConnectUnsupportedMethodError';
    this.method = method;
    this.supportedMethods = supportedMethods;
  }
}

function getSessionMethods(session: WalletConnectSession): string[] {
  const methods: string[] = [];
  for (const namespace of Object.values(session.namespaces ?? {})) {
    if (!Array.isArray(namespace?.methods)) {
      continue;
    }
    for (const method of namespace.methods) {
      if (typeof method === 'string' && method.length > 0) {
        methods.push(method);
      }
    }
  }
  return methods;
}

/**
 * Ensures the session's namespaces advertise the signing method. Method names
 * are compared case-insensitively because wallets in the wild report both
 * `stellar_signXDR` and `stellar_signXdr`.
 */
function assertSessionSupportsMethod(session: WalletConnectSession, method: string): void {
  const supportedMethods = getSessionMethods(session);
  const required = method.toLowerCase();
  if (!supportedMethods.some((supported) => supported.toLowerCase() === required)) {
    throw new WalletConnectUnsupportedMethodError(method, supportedMethods);
  }
}

function getFirstAccount(session: WalletConnectSession): string | undefined {
  const namespaces = session.namespaces ?? {};
  const stellarNamespace = namespaces['stellar'];
  if (stellarNamespace?.accounts?.[0]) {
    return stellarNamespace.accounts[0];
  }

  for (const namespace of Object.values(namespaces)) {
    const account = namespace.accounts?.[0];
    if (account) {
      return account;
    }
  }
  return undefined;
}

function getDefaultPublicKeyFromSession(session: WalletConnectSession): string {
  const account = getFirstAccount(session);
  if (!account) {
    throw new Error('WalletConnect session does not contain a Stellar account');
  }

  const parts = account.split(':');
  return parts[parts.length - 1] ?? account;
}

function getDefaultChainId(session: WalletConnectSession): string {
  const account = getFirstAccount(session);
  if (!account) {
    throw new Error('WalletConnect session does not contain a WalletConnect chain id');
  }

  const parts = account.split(':');
  if (parts.length >= 2) {
    return `${parts[0]}:${parts[1]}`;
  }

  throw new Error('WalletConnect account is not in namespace:chain:address format');
}

function getDefaultNetwork(session: WalletConnectSession): { network: string; networkPassphrase: string } {
  const chainId = getDefaultChainId(session);
  switch (chainId) {
    case 'stellar:testnet':
      return { network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' };
    case 'stellar:pubnet':
      return { network: 'mainnet', networkPassphrase: 'Public Global Stellar Network ; September 2015' };
    default:
      return {
        network: chainId,
        networkPassphrase: session.sessionProperties?.networkPassphrase ?? '',
      };
  }
}

/**
 * Validates a WalletConnect signing response and returns the signed
 * transaction envelope XDR as a string.
 *
 * Wallets may respond with either a bare XDR string or a `SignedTransaction`
 * object (`{ envelope_xdr, hash }`). Passing the object through to code that
 * expects a string causes a cast/serialization error, so we unwrap and validate
 * the response here.
 */
export function extractSignedTransactionXdr(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (
    response &&
    typeof response === 'object' &&
    'signedXDR' in response &&
    typeof response.signedXDR === 'string'
  ) {
    return response.signedXDR;
  }

  if (
    response &&
    typeof response === 'object' &&
    'signedTxXdr' in response &&
    typeof response.signedTxXdr === 'string'
  ) {
    return response.signedTxXdr;
  }

  if (
    response &&
    typeof response === 'object' &&
    'envelope_xdr' in response &&
    typeof response.envelope_xdr === 'string'
  ) {
    return response.envelope_xdr;
  }

  throw new Error('WalletConnect signing response did not include a signed transaction XDR');
}

function getDefaultSignedTransactionXdr(response: unknown): string {
  return extractSignedTransactionXdr(response);
}

export class MemoryWalletConnectSessionStore implements WalletConnectSessionStore {
  private sessionTopic: string | null = null;

  async getSessionTopic(): Promise<string | null> {
    return this.sessionTopic;
  }

  async setSessionTopic(topic: string): Promise<void> {
    this.sessionTopic = topic;
  }

  async clearSessionTopic(): Promise<void> {
    this.sessionTopic = null;
  }
}

export class LocalStorageWalletConnectSessionStore implements WalletConnectSessionStore {
  private readonly storage: Storage;
  private readonly key: string;

  constructor(storage: Storage, key = 'sorowill:walletconnect:session-topic') {
    this.storage = storage;
    this.key = key;
  }

  async getSessionTopic(): Promise<string | null> {
    return this.storage.getItem(this.key);
  }

  async setSessionTopic(topic: string): Promise<void> {
    this.storage.setItem(this.key, topic);
  }

  async clearSessionTopic(): Promise<void> {
    this.storage.removeItem(this.key);
  }
}

export class WalletConnectAdapter implements WalletAdapter {
  private readonly client: WalletConnectClient;
  private readonly options: WalletConnectAdapterOptions;
  private readonly sessionStore: WalletConnectSessionStore;
  private session: WalletConnectSession | null = null;
  private connection: WalletConnection | null = null;

  constructor(client: WalletConnectClient, options: WalletConnectAdapterOptions = {}) {
    this.client = client;
    this.options = options;
    this.sessionStore = options.sessionStore ?? new MemoryWalletConnectSessionStore();
  }

  async isConnected(): Promise<boolean> {
    if (this.session) {
      return true;
    }

    const topic = await this.sessionStore.getSessionTopic();
    if (!topic) {
      return false;
    }

    const session = await this.client.getSession(topic);
    return session !== null;
  }

  async connect(): Promise<WalletConnection> {
    const connectOptions: {
      requiredNamespaces: Record<string, WalletConnectSessionNamespace>;
      optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
      pairingTopic?: string;
    } = {
      requiredNamespaces: this.options.requiredNamespaces ?? DEFAULT_REQUIRED_NAMESPACES,
    };
    if (this.options.optionalNamespaces) {
      connectOptions.optionalNamespaces = this.options.optionalNamespaces;
    }
    if (this.options.pairingTopic) {
      connectOptions.pairingTopic = this.options.pairingTopic;
    }

    const connection = await this.client.connect(connectOptions);

    if (connection.uri) {
      await this.options.onPairingUri?.(connection.uri);
    }

    const connectTimeoutMs = this.options.connectTimeoutMs ?? _DEFAULT_CONNECT_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`WalletConnect pairing approval timed out after ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      );
    });

    let session: WalletConnectSession;
    try {
      session = await Promise.race([connection.approval(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
    return this.useSession(session);
  }

  async reconnect(): Promise<WalletConnection> {
    if (this.session && this.connection) {
      const freshSession = await this.client.getSession(this.session.topic);
      if (freshSession) {
        return this.useSession(freshSession);
      }
      this.session = null;
      this.connection = null;
      await this.sessionStore.clearSessionTopic();
    }

    const topic = await this.sessionStore.getSessionTopic();
    if (!topic) {
      throw new Error('No WalletConnect session topic is stored');
    }

    const session = await this.client.getSession(topic);
    if (!session) {
      await this.sessionStore.clearSessionTopic();
      throw new Error('Stored WalletConnect session no longer exists');
    }

    return this.useSession(session);
  }

  async disconnect(): Promise<void> {
    const topic = this.session?.topic ?? (await this.sessionStore.getSessionTopic());
    if (topic) {
      await this.client.disconnect({
        topic,
        reason: this.options.disconnectReason ?? DEFAULT_DISCONNECT_REASON,
      });
    }

    this.session = null;
    this.connection = null;
    await this.sessionStore.clearSessionTopic();
  }

  private async requireSession(): Promise<WalletConnectSession> {
    if (this.session) {
      return this.session;
    }

    const topic = await this.sessionStore.getSessionTopic();
    if (!topic) {
      throw new Error('WalletConnect session not available. Call connect() first.');
    }

    const session = await this.client.getSession(topic);
    if (!session) {
      throw new Error('WalletConnect session could not be found. Reconnect required.');
    }

    this.session = session;
    return session;
  }

  async getPublicKey(): Promise<string> {
    const session = await this.requireSession();
    const resolver = this.options.getPublicKeyFromSession ?? getDefaultPublicKeyFromSession;
    return resolver(session);
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const session = await this.requireSession();
    const resolver = this.options.getNetworkFromSession ?? getDefaultNetwork;
    return resolver(session);
  }

  async signTransaction(xdr: string, options?: SignTransactionOptions): Promise<string> {
    const session = await this.requireSession();

    // Validate that the requested networkPassphrase matches the session's network
    if (options?.networkPassphrase) {
      const sessionNetwork = this.resolveNetwork(session);
      if (options.networkPassphrase !== sessionNetwork.networkPassphrase) {
        throw new Error(
          `WalletConnect session is connected to ${sessionNetwork.networkPassphrase}, ` +
          `but transaction is for ${options.networkPassphrase}`
        );
      }
    }

    const method = this.getSignTransactionMethod();
    assertSessionSupportsMethod(session, method);

    const chainId = this.options.requestChainId ?? getDefaultChainId(session);
    const network = this.resolveNetwork(session);
    const params = this.options.getSignTransactionParams?.(xdr, network.networkPassphrase) ?? { xdr };

    const response = await this.withTimeout(
      this.client.request<unknown>({
        topic: session.topic,
        chainId,
        request: {
          method,
          params,
        },
      }),
    );

    const extractor = this.options.getSignedTransactionXdr ?? getDefaultSignedTransactionXdr;
    return extractor(response);
  }

  private getSignTransactionMethod(): string {
    return this.options.signTransactionMethod ?? DEFAULT_SIGN_TRANSACTION_METHOD;
  }

  private useSession(session: WalletConnectSession): WalletConnection {
    assertSessionSupportsMethod(session, this.getSignTransactionMethod());
    this.session = session;
    this.connection = {
      publicKey: (this.options.getPublicKeyFromSession ?? getDefaultPublicKeyFromSession)(session),
      network: (this.options.getNetworkFromSession ?? getDefaultNetwork)(session).network,
      networkPassphrase: this.resolveNetwork(session).networkPassphrase,
    };
    void this.sessionStore.setSessionTopic(session.topic);
    return this.connection;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number = _DEFAULT_SIGN_TIMEOUT_MS): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          reject(new SignTransactionTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  }

  private resolveNetwork(session: WalletConnectSession): { network: string; networkPassphrase: string } {
    return (
      this.options.getNetworkFromSession?.(session) ?? {
        network: this.options.network ?? getDefaultNetwork(session).network,
        networkPassphrase:
          this.options.networkPassphrase ?? getDefaultNetwork(session).networkPassphrase,
      }
    );
  }
}

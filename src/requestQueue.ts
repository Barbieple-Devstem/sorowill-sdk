import { RequestTimeoutError } from './errors';

/**
 * Rate and concurrency controls used by the client's shared RPC request queue.
 *
 * The queue is fair in that it respects both FIFO ordering and request priority:
 * requests are executed in strict FIFO order when they have the same priority.
 * When a request with higher priority is enqueued, it will be executed ahead of
 * lower-priority requests that are already queued, but after any requests that
 * were already being processed.
 */
export interface RequestQueueOptions {
  /** Maximum number of RPC requests in flight at once. Defaults to 4. */
  maxConcurrent?: number;
  /**
   * Maximum number of RPC requests started in any rolling one-second window. Defaults to 10.
   *
   * This enforces rate limiting at the RPC server level. High-priority requests
   * may still be delayed if the rate limit has been exhausted.
   */
  requestsPerSecond?: number;
  /**
   * Optional account key. When provided, all {@link RequestQueue} instances
   * created with the same key share a single underlying queue, so operations
   * for a given account are serialized even if multiple clients (or multiple
   * queues) are created for that account in rapid succession.
   */
  account?: string;
  /**
   * Maximum number of times a request that fails with a rate-limit error
   * (HTTP 429 / "too many requests") is retried before the error is surfaced.
   * Defaults to 3. Set to 0 to disable rate-limit retries.
   */
  maxRateLimitRetries?: number;
  /**
   * Base delay in milliseconds for rate-limit retries. The n-th retry waits
   * `2^n * retryBaseDelayMs` (capped by {@link maxBackoffMs}). Defaults to 500.
   */
  retryBaseDelayMs?: number;
  /** Upper bound in milliseconds for a single backoff delay. Defaults to 60 000 (60s). */
  maxBackoffMs?: number;
}

/** Default cap applied to a single exponential backoff delay (60 seconds). */
export const MAX_BACKOFF_MS = 60_000;

/**
 * Computes the exponential backoff delay for a retry: `2^attempt * baseDelayMs`,
 * capped at `maxBackoffMs`. `attempt` is zero-based (the first retry is attempt 0).
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxBackoffMs: number = MAX_BACKOFF_MS,
): number {
  const delay = 2 ** attempt * baseDelayMs;
  return Number.isFinite(delay) ? Math.min(delay, maxBackoffMs) : maxBackoffMs;
}

/**
 * Returns true when `error` signals that the RPC endpoint rate-limited the
 * request (HTTP 429 or a "too many requests" / "rate limit" message).
 */
export function isRateLimitError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === 'object') {
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };
    if (
      candidate.status === 429 ||
      candidate.statusCode === 429 ||
      candidate.response?.status === 429
    ) {
      return true;
    }
  }
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lower = text.toLowerCase();
  return lower.includes('too many requests') || lower.includes('rate limit') || /\b429\b/.test(text);
}

/** Priority level for requests in the queue. Higher priority requests are processed first within FIFO ordering constraints. */
export enum RequestPriority {
  /** Low priority for background operations (e.g., UI polling). */
  Low = 0,
  /** Normal priority for regular operations. Default priority. */
  Normal = 1,
  /** High priority for user-initiated operations (e.g., form submissions). */
  High = 2,
}

interface PendingRequest<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  priority: RequestPriority;
  enqueuedAt: number;
}

/**
 * Shared state for a single account. Multiple {@link RequestQueue} instances
 * created for the same account delegate to the same {@link QueueCore}, which
 * guarantees their operations are serialized against one another.
 */
class QueueCore {
  readonly maxConcurrent: number;
  readonly requestsPerSecond: number;
  readonly maxRateLimitRetries: number;
  readonly retryBaseDelayMs: number;
  readonly maxBackoffMs: number;
  readonly pending: Array<PendingRequest<unknown>> = [];
  readonly starts: number[] = [];
  active = 0;
  wakeTimer: ReturnType<typeof setTimeout> | undefined;
  refCount = 0;

  constructor(
    maxConcurrent: number,
    requestsPerSecond: number,
    maxRateLimitRetries: number,
    retryBaseDelayMs: number,
    maxBackoffMs: number,
  ) {
    this.maxConcurrent = maxConcurrent;
    this.requestsPerSecond = requestsPerSecond;
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.maxBackoffMs = maxBackoffMs;
  }
}

/**
 * Process-wide registry of shared queue cores keyed by account. This is what
 * makes {@link RequestQueue} effectively a singleton per account: two queues
 * constructed for the same account within milliseconds coordinate through the
 * same core instead of racing each other.
 */
const sharedCores = new Map<string, QueueCore>();

/** FIFO queue that applies concurrency, rate, and timeout limits to asynchronous requests. */
export class RequestQueue {
  private readonly core: QueueCore;
  private readonly account: string | undefined;
  private released = false;

  constructor(options: RequestQueueOptions = {}) {
    const maxConcurrent = options.maxConcurrent ?? 4;
    const requestsPerSecond = options.requestsPerSecond ?? 10;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer');
    }
    if (!Number.isInteger(requestsPerSecond) || requestsPerSecond < 1) {
      throw new RangeError('requestsPerSecond must be a positive integer');
    }
    const maxRateLimitRetries = options.maxRateLimitRetries ?? 3;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
    if (!Number.isInteger(maxRateLimitRetries) || maxRateLimitRetries < 0) {
      throw new RangeError('maxRateLimitRetries must be a non-negative integer');
    }
    if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0) {
      throw new RangeError('retryBaseDelayMs must be a finite, non-negative number');
    }
    if (!Number.isFinite(maxBackoffMs) || maxBackoffMs < 0 || maxBackoffMs > MAX_BACKOFF_MS) {
      throw new RangeError(`maxBackoffMs must be between 0 and ${MAX_BACKOFF_MS}`);
    }
    this.account = options.account;
    if (this.account !== undefined) {
      let core = sharedCores.get(this.account);
      if (core === undefined) {
        core = new QueueCore(maxConcurrent, requestsPerSecond, maxRateLimitRetries, retryBaseDelayMs, maxBackoffMs);
        sharedCores.set(this.account, core);
      }
      core.refCount += 1;
      this.core = core;
    } else {
      this.core = new QueueCore(maxConcurrent, requestsPerSecond, maxRateLimitRetries, retryBaseDelayMs, maxBackoffMs);
    }
  }

  enqueue<T>(run: () => Promise<T>, timeoutMs?: number, signal?: AbortSignal, priority: RequestPriority = RequestPriority.Normal): Promise<T> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return Promise.reject(new RangeError('timeoutMs must be greater than zero'));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
      const request: PendingRequest<T> = { run, resolve, reject, timeoutMs, signal, abortListener: undefined, priority, enqueuedAt: Date.now() };
      if (signal) {
        request.abortListener = () => {
          // Drop the request from the queue so an aborted request never runs.
          const index = this.core.pending.indexOf(request as PendingRequest<unknown>);
          if (index !== -1) this.core.pending.splice(index, 1);
          this.removeAbortListener(request);
          reject(signal.reason);
        };
        signal.addEventListener('abort', request.abortListener);
      }
      this.core.pending.push(request as PendingRequest<unknown>);
      this.drain();
    });
  }

  /**
   * Rejects every request that is queued but not yet started, clearing the
   * pending list. Active (already-started) requests are not affected here —
   * callers should abort those separately via {@link InFlightTracker.clear}.
   *
   * Intended to be called by {@link SoroWillClient.destroy} so that any
   * requests enqueued after unmount/teardown do not run to completion.
   */
  rejectAll(reason: unknown): void {
    if (this.core.wakeTimer !== undefined) {
      clearTimeout(this.core.wakeTimer);
      this.core.wakeTimer = undefined;
    }
    const drained = this.core.pending.splice(0);
    for (const request of drained) {
      this.removeAbortListener(request);
      request.reject(reason);
    }
  }

  /**
   * Releases this queue's reference to the shared per-account core. When the
   * last queue for an account is released, the shared core is dropped so a
   * later client for the same account starts from a clean state.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.account === undefined) return;
    const core = sharedCores.get(this.account);
    if (core !== this.core) return;
    core.refCount -= 1;
    if (core.refCount <= 0) {
      sharedCores.delete(this.account);
    }
  }

  private removeAbortListener(request: { signal: AbortSignal | undefined; abortListener: (() => void) | undefined }): void {
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener('abort', request.abortListener);
    }
  }

  private drain(): void {
    const core = this.core;
    if (core.wakeTimer !== undefined) {
      clearTimeout(core.wakeTimer);
      core.wakeTimer = undefined;
    }
    const now = Date.now();
    while (core.starts[0] !== undefined && core.starts[0] <= now - 1_000) {
      core.starts.shift();
    }
    while (
      core.active < core.maxConcurrent &&
      core.starts.length < core.requestsPerSecond &&
      core.pending.length > 0
    ) {
      const request = this.selectNextRequest();
      if (request === undefined) break;
      core.active += 1;
      core.starts.push(Date.now());
      this.removeAbortListener(request);
      void this.execute(request);
    }
    if (
      core.pending.length > 0 &&
      core.active < core.maxConcurrent &&
      core.starts[0] !== undefined
    ) {
      const delay = Math.max(1, core.starts[0] + 1_000 - Date.now());
      core.wakeTimer = setTimeout(() => this.drain(), delay);
    }
  }

  private selectNextRequest(): PendingRequest<unknown> | undefined {
    const pending = this.core.pending;
    if (pending.length === 0) {
      return undefined;
    }
    let selectedIndex = 0;
    let selectedPriority = pending[0]!.priority;
    for (let i = 1; i < pending.length; i++) {
      if (pending[i]!.priority > selectedPriority) {
        selectedIndex = i;
        selectedPriority = pending[i]!.priority;
      }
    }
    const [request] = pending.splice(selectedIndex, 1);
    return request;
  }

  private async execute<T>(request: PendingRequest<T>): Promise<void> {
    try {
      let attempt = 0;
      for (;;) {
        try {
          request.resolve(await this.runAttempt(request));
          return;
        } catch (error) {
          if (!isRateLimitError(error) || attempt >= this.core.maxRateLimitRetries) {
            throw error;
          }
          // Back off exponentially instead of hammering a rate-limited endpoint.
          await this.sleep(
            computeBackoffDelay(attempt, this.core.retryBaseDelayMs, this.core.maxBackoffMs),
            request.signal,
          );
          attempt += 1;
        }
      }
    } catch (error) {
      request.reject(error);
    } finally {
      this.removeAbortListener(request);
      this.core.active -= 1;
      this.drain();
    }
  }

  private async runAttempt<T>(request: PendingRequest<T>): Promise<T> {
    if (request.timeoutMs === undefined) {
      return request.run();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request.run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RequestTimeoutError(request.timeoutMs as number)),
            request.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Waits `ms` milliseconds, rejecting early with the abort reason if `signal` fires. */
  private sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

const sharedQueueMap = new Map<string, RequestQueue>();

export function getSharedRequestQueue(account?: string): RequestQueue {
  const key = account ?? '__default__';
  if (!sharedQueueMap.has(key)) {
    const opts: RequestQueueOptions = account !== undefined ? { account } : {};
    sharedQueueMap.set(key, new RequestQueue(opts));
  }
  return sharedQueueMap.get(key)!;
}

export function releaseSharedRequestQueue(account?: string): void {
  const key = account ?? '__default__';
  const queue = sharedQueueMap.get(key);
  if (queue) {
    queue.release();
    sharedQueueMap.delete(key);
  }
}

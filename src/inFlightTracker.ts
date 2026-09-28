type OperationKey = string;
type OperationResult<T> = Promise<T>;

interface InFlightOperation<T> {
  promise: OperationResult<T>;
  controller: AbortController;
}

/**
 * Tracks in-flight operations to deduplicate concurrent identical requests.
 *
 * ## Scope and key construction (#503)
 *
 * Prior to the #503 fix the dedup key was `${willId}:${method}`. This worked
 * correctly when all calls came through a single client instance, but broke
 * when two `SoroWillClient` instances pointed at different contracts (or
 * different networks) shared the same `InFlightTracker`: a `check_in` call for
 * will `1` on the testnet contract would be silently deduplicated with a
 * `check_in` call for will `1` on a completely different mainnet contract.
 *
 * The fix: `InFlightTracker` now optionally accepts a `scopeId` at construction
 * time (typically the contract address). When set, the key becomes
 * `${scopeId}::${willId}:${method}`, ensuring that the same (willId, method)
 * pair on two different contracts is never mistaken for a duplicate.
 *
 * ### Sharing a tracker across client instances
 *
 * If you want true cross-instance deduplication (e.g. two `SoroWillClient`
 * instances that both target the *same* contract and should share a single
 * in-flight map), construct one `InFlightTracker` with the shared `scopeId`
 * and pass it to both clients via `SoroWillClientOptions.inFlightTracker`:
 *
 * ```ts
 * import { InFlightTracker, SoroWillClient } from '@sorowill/sdk';
 *
 * const sharedTracker = new InFlightTracker('CA3D5KRY...');
 *
 * const clientA = new SoroWillClient({ ..., inFlightTracker: sharedTracker });
 * const clientB = new SoroWillClient({ ..., inFlightTracker: sharedTracker });
 * ```
 *
 * Both clients will now share the same in-flight map, and a duplicate
 * operation started from `clientA` while `clientB` already has the same
 * operation pending will receive the same promise rather than launching a
 * second RPC call.
 */
export class InFlightTracker {
  private readonly inFlight = new Map<OperationKey, InFlightOperation<unknown>>();

  /**
   * Optional scope identifier (e.g. a contract address) prepended to every
   * key to prevent cross-contract or cross-network dedup collisions (#503).
   */
  private readonly scopeId: string | undefined;

  constructor(scopeId?: string) {
    this.scopeId = scopeId;
  }

  getKey(willId: string | bigint, method: string): OperationKey {
    const id = typeof willId === 'bigint' ? willId.toString() : willId;
    return this.scopeId ? `${this.scopeId}::${id}:${method}` : `${id}:${method}`;
  }

  isInFlight(willId: string | bigint, method: string): boolean {
    return this.inFlight.has(this.getKey(willId, method));
  }

  getInFlightPromise<T>(willId: string | bigint, method: string): OperationResult<T> | undefined {
    const op = this.inFlight.get(this.getKey(willId, method));
    return op?.promise as OperationResult<T> | undefined;
  }

  track<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
  ): PromiseLike<T> {
    const key = this.getKey(willId, method);

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)!.promise as PromiseLike<T>;
    }

    const controller = new AbortController();
    const promise = Promise.resolve(operation(controller.signal)).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, { promise, controller });
    return promise;
  }

  clear(): void {
    for (const { controller } of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }

  abort(willId: string | bigint, method: string): void {
    const key = this.getKey(willId, method);
    const op = this.inFlight.get(key);
    if (op) {
      op.controller.abort();
      this.inFlight.delete(key);
    }
  }
}

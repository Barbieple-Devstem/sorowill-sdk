import { Keypair, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

export interface TransactionMatchOptions {
  intendedTransactionXdr: string;
  preparedTransactionXdr: string;
  networkPassphrase: string;
  context: string;
  /**
   * Optional Soroban simulation response associated with the prepared
   * transaction.  When provided, the simulation's `status` field is checked
   * before any structural comparison is performed.  A status other than
   * `"SUCCESS"` throws {@link SimulationResultError} immediately so that
   * invalid prepared transactions are caught before they reach the network.
   *
   * Pass the raw object returned by `rpc.Server.simulateTransaction()` (or
   * `rpc.Server.prepareTransaction()`'s underlying simulation response).
   */
  simulationResponse?: SimulationResponse;
}

/**
 * Minimal shape of a Soroban RPC simulation response needed for status
 * validation.  Using a structural type avoids a hard dependency on the
 * `@stellar/stellar-sdk` RPC type hierarchy.
 */
export interface SimulationResponse {
  /** `"SUCCESS"` indicates a simulation that the contract accepted. */
  status?: string;
  /** Human-readable error detail returned by the RPC node on failure. */
  error?: string;
}

/**
 * Raised by {@link assertPreparedTransactionMatchesIntendedOperation} when the
 * accompanying Soroban simulation response does not carry a `"SUCCESS"` status.
 *
 * A prepared transaction backed by a failed simulation will be rejected
 * on-chain, so throwing here saves a full RPC submission round-trip.
 */
export class SimulationResultError extends Error {
  /**
   * The status value returned by the simulation, e.g. `"ERROR"` or
   * `"FAILED"`.  Never embedded in the message because it may contain raw
   * contract addresses or other request-specific data.
   */
  readonly simulationStatus: string | undefined;
  /**
   * The raw error string from the simulation response, if present.  Kept as a
   * structured property rather than embedded in the message for the same
   * privacy reasons as {@link simulationStatus}.
   */
  readonly simulationError: string | undefined;

  constructor(
    context: string,
    simulationStatus: string | undefined,
    simulationError: string | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `Soroban simulation for ${context} did not succeed — the prepared transaction should not be submitted.`,
      options,
    );
    this.name = 'SimulationResultError';
    this.simulationStatus = simulationStatus;
    this.simulationError = simulationError;
  }
}

function operationsMatch(intended: xdr.Operation, prepared: xdr.Operation): boolean {
  const intendedType = intended.body().switch();
  const preparedType = prepared.body().switch();

  if (intendedType !== preparedType) {
    return false;
  }

  if (intendedType === xdr.OperationType.invokeHostFunction()) {
    const intendedOp = intended.body().invokeHostFunctionOp();
    const preparedOp = prepared.body().invokeHostFunctionOp();

    if (!intendedOp || !preparedOp) {
      return false;
    }

    const intendedHostFn = intendedOp.hostFunction();
    const preparedHostFn = preparedOp.hostFunction();

    if (!intendedHostFn || !preparedHostFn) {
      return false;
    }

    if (intendedHostFn.switch() !== preparedHostFn.switch()) {
      return false;
    }

    if (intendedHostFn.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      const intendedInvoke = intendedHostFn.invokeContract();
      const preparedInvoke = preparedHostFn.invokeContract();

      if (
        intendedInvoke.contractAddress().toXDR('base64') !==
          preparedInvoke.contractAddress().toXDR('base64') ||
        intendedInvoke.functionName().toString() !== preparedInvoke.functionName().toString()
      ) {
        return false;
      }

      const intendedArgs = intendedInvoke.args();
      const preparedArgs = preparedInvoke.args();

      if (!intendedArgs || !preparedArgs || intendedArgs.length !== preparedArgs.length) {
        return false;
      }

      for (let i = 0; i < intendedArgs.length; i++) {
        if (intendedArgs[i]!.toXDR('base64') !== preparedArgs[i]!.toXDR('base64')) {
          return false;
        }
      }

      return true;
    }

    return false;
  }

  return prepared.toXDR('base64') === intended.toXDR('base64');
}

function readOperationsFromEnvelope(
  transactionXdr: string,
  networkPassphrase: string,
): xdr.Operation[] {
  const transaction = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  const envelope = transaction.toEnvelope() as unknown as {
    v0?: () => { tx: () => { operations: () => xdr.Operation[] } };
    v1?: () => { tx: () => { operations: () => xdr.Operation[] } };
    feeBump?: () => {
      tx: () => {
        innerTx: () => {
          v1: () => { tx: () => { operations: () => xdr.Operation[] } };
        };
      };
    };
  };

  if (typeof envelope.v1 === 'function') {
    try {
      return envelope.v1().tx().operations();
    } catch {
      // fall through and try the remaining envelope variants
    }
  }

  if (typeof envelope.v0 === 'function') {
    try {
      return envelope.v0().tx().operations();
    } catch {
      // fall through and try the remaining envelope variants
    }
  }

  if (typeof envelope.feeBump === 'function') {
    try {
      return envelope.feeBump().tx().innerTx().v1().tx().operations();
    } catch {
      // fall through to the final error below
    }
  }

  throw new Error('Unable to decode transaction operations from XDR envelope');
}

export function assertPreparedTransactionMatchesIntendedOperation(
  options: TransactionMatchOptions,
): void {
  // Check the simulation result status before doing any structural validation.
  // A prepared transaction backed by a failed simulation will be rejected
  // on-chain, so we surface the problem here rather than at submission time.
  if (options.simulationResponse !== undefined) {
    const status = options.simulationResponse.status;
    if (status !== undefined && status !== 'SUCCESS') {
      throw new SimulationResultError(
        options.context,
        status,
        options.simulationResponse.error,
      );
    }
  }

  const intendedOperations = readOperationsFromEnvelope(
    options.intendedTransactionXdr,
    options.networkPassphrase,
  );
  const preparedOperations = readOperationsFromEnvelope(
    options.preparedTransactionXdr,
    options.networkPassphrase,
  );

  if (preparedOperations.length !== intendedOperations.length) {
    throw new Error(
      `Prepared transaction for ${options.context} contained ${preparedOperations.length} operation(s), expected ${intendedOperations.length}`,
    );
  }

  for (let index = 0; index < intendedOperations.length; index += 1) {
    const intended = intendedOperations[index];
    const prepared = preparedOperations[index];
    if (!intended || !prepared) {
      throw new Error(`Prepared transaction for ${options.context} was missing operation ${index}`);
    }

    if (!operationsMatch(intended, prepared)) {
      throw new Error(
        `Prepared transaction for ${options.context} did not match the intended operation at index ${index}`,
      );
    }
  }
}

/** Length in bytes of an Ed25519 signature, the only algorithm Stellar accepts for account signers. */
export const ED25519_SIGNATURE_LENGTH = 64;
/** Length in bytes of a Stellar signature hint (the last 4 bytes of the signer's Ed25519 public key). */
export const SIGNATURE_HINT_LENGTH = 4;

/**
 * Raised when a transaction carries a signature that is not a well-formed
 * Ed25519 signature, or one that does not verify against an expected signer.
 */
export class UnsupportedSignatureAlgorithmError extends Error {
  /** Index of the offending signature within the envelope. */
  readonly signatureIndex: number;

  constructor(context: string, signatureIndex: number, reason: string) {
    super(`Signature ${signatureIndex} on ${context} was rejected: ${reason}`);
    this.name = 'UnsupportedSignatureAlgorithmError';
    this.signatureIndex = signatureIndex;
  }
}

export interface SignatureValidationOptions {
  /** Human-readable label used in error messages. */
  context: string;
  /**
   * Public keys (G...) expected to have signed the transaction. When given,
   * every signature must carry the hint of one of these keys and verify as a
   * valid Ed25519 signature over the transaction hash.
   */
  expectedSigners?: readonly string[];
}

/** Minimal transaction shape needed for signature validation. */
export interface SignedTransactionLike {
  signatures?: readonly xdr.DecoratedSignature[];
  hash?: () => Buffer;
}

function toBytes(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

/**
 * Ensures every signature on `transaction` uses the Ed25519 algorithm.
 *
 * Stellar account signatures are always 64-byte Ed25519 signatures paired
 * with a 4-byte hint. Anything else (truncated, padded, or produced by a
 * different algorithm such as secp256k1/ECDSA) is rejected before submission.
 * When `expectedSigners` is supplied, each signature is additionally verified
 * cryptographically against the matching signer's public key.
 *
 * @throws {UnsupportedSignatureAlgorithmError} On the first invalid signature.
 */
export function assertSupportedSignatureAlgorithm(
  transaction: SignedTransactionLike,
  options: SignatureValidationOptions,
): void {
  const signatures = transaction.signatures ?? [];
  const signers = (options.expectedSigners ?? []).map((publicKey) => Keypair.fromPublicKey(publicKey));
  const txHash = signers.length > 0 ? transaction.hash?.() : undefined;

  signatures.forEach((decorated, index) => {
    const signature = toBytes(decorated.signature());
    const hint = toBytes(decorated.hint());

    if (!signature || signature.length !== ED25519_SIGNATURE_LENGTH) {
      throw new UnsupportedSignatureAlgorithmError(
        options.context,
        index,
        `expected a ${ED25519_SIGNATURE_LENGTH}-byte Ed25519 signature, got ${signature?.length ?? 0} bytes`,
      );
    }
    if (!hint || hint.length !== SIGNATURE_HINT_LENGTH) {
      throw new UnsupportedSignatureAlgorithmError(
        options.context,
        index,
        `expected a ${SIGNATURE_HINT_LENGTH}-byte Ed25519 signature hint`,
      );
    }

    if (signers.length === 0) return;

    const hintHex = Buffer.from(hint).toString('hex');
    const signer = signers.find(
      (candidate) => candidate.signatureHint().toString('hex') === hintHex,
    );
    if (!signer) {
      throw new UnsupportedSignatureAlgorithmError(
        options.context,
        index,
        'signature hint does not match any expected Ed25519 signer',
      );
    }
    if (!txHash || !signer.verify(txHash, Buffer.from(signature))) {
      throw new UnsupportedSignatureAlgorithmError(
        options.context,
        index,
        'signature is not a valid Ed25519 signature from the expected signer',
      );
    }
  });
}

/**
 * Decodes `signedTransactionXdr` and applies {@link assertSupportedSignatureAlgorithm}
 * to it (to the outer envelope for fee-bump transactions).
 */
export function assertSignedTransactionXdrSignatures(
  signedTransactionXdr: string,
  networkPassphrase: string,
  options: SignatureValidationOptions,
): void {
  const transaction = TransactionBuilder.fromXDR(signedTransactionXdr, networkPassphrase);
  assertSupportedSignatureAlgorithm(transaction as unknown as SignedTransactionLike, options);
}

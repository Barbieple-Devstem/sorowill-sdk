import { describe, expect, it } from 'vitest';
import { Account, Keypair, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import {
  assertSignedTransactionXdrSignatures,
  assertSupportedSignatureAlgorithm,
  UnsupportedSignatureAlgorithmError,
} from '../src/txValidation';

function buildTx(source: Keypair) {
  return new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: 'sorowill', value: 'payload' }))
    .setTimeout(30)
    .build();
}

describe('#607 transaction signature algorithm validation', () => {
  const signer = Keypair.random();

  it('accepts a valid Ed25519 signature', () => {
    const tx = buildTx(signer);
    tx.sign(signer);

    expect(() => assertSupportedSignatureAlgorithm(tx, { context: 'test' })).not.toThrow();
    expect(() =>
      assertSupportedSignatureAlgorithm(tx, {
        context: 'test',
        expectedSigners: [signer.publicKey()],
      }),
    ).not.toThrow();
    expect(() =>
      assertSignedTransactionXdrSignatures(tx.toXDR(), Networks.TESTNET, { context: 'test' }),
    ).not.toThrow();
  });

  it('accepts an unsigned transaction', () => {
    expect(() => assertSupportedSignatureAlgorithm(buildTx(signer), { context: 'test' })).not.toThrow();
  });

  it('rejects a non-Ed25519 (65-byte ECDSA-style) signature', () => {
    const tx = buildTx(signer);
    tx.signatures.push(
      new xdr.DecoratedSignature({
        hint: signer.signatureHint(),
        signature: Buffer.alloc(65, 1),
      }),
    );

    expect(() => assertSupportedSignatureAlgorithm(tx, { context: 'test' })).toThrow(
      UnsupportedSignatureAlgorithmError,
    );
  });

  it('rejects a truncated signature after an XDR round trip', () => {
    const tx = buildTx(signer);
    tx.signatures.push(
      new xdr.DecoratedSignature({
        hint: signer.signatureHint(),
        signature: Buffer.alloc(32, 7),
      }),
    );

    expect(() =>
      assertSignedTransactionXdrSignatures(tx.toXDR(), Networks.TESTNET, { context: 'test' }),
    ).toThrow(/64-byte Ed25519 signature/);
  });

  it('rejects a 64-byte signature that does not verify against the expected signer', () => {
    const tx = buildTx(signer);
    tx.signatures.push(
      new xdr.DecoratedSignature({
        hint: signer.signatureHint(),
        signature: Buffer.alloc(64, 9),
      }),
    );

    expect(() =>
      assertSupportedSignatureAlgorithm(tx, {
        context: 'test',
        expectedSigners: [signer.publicKey()],
      }),
    ).toThrow(/not a valid Ed25519 signature/);
  });

  it('rejects a signature from an unexpected signer', () => {
    const other = Keypair.random();
    const tx = buildTx(signer);
    tx.sign(other);

    expect(() =>
      assertSupportedSignatureAlgorithm(tx, {
        context: 'test',
        expectedSigners: [signer.publicKey()],
      }),
    ).toThrow(/does not match any expected Ed25519 signer/);
  });
});

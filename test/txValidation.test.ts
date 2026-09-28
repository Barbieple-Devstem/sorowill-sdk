import { describe, expect, it } from 'vitest';
import {
  Account,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  assertPreparedTransactionMatchesIntendedOperation,
  SimulationResultError,
} from '../src/txValidation';

describe('assertPreparedTransactionMatchesIntendedOperation', () => {
  function buildManageDataTx(name: string) {
    const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    return new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name, value: 'payload' }))
      .setTimeout(30)
      .build();
  }

  describe('manageData operations', () => {
    it('accepts a prepared transaction when the decoded operation matches', () => {
      const tx = buildManageDataTx('sorowill');

      expect(() =>
        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: tx.toXDR(),
          preparedTransactionXdr: tx.toXDR(),
          networkPassphrase: Networks.TESTNET,
          context: 'manage_data',
        }),
      ).not.toThrow();
    });

    it('throws when the decoded operation does not match the intended one', () => {
      const intendedTx = buildManageDataTx('sorowill');
      const mismatchedTx = buildManageDataTx('tampered');

      expect(() =>
        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: intendedTx.toXDR(),
          preparedTransactionXdr: mismatchedTx.toXDR(),
          networkPassphrase: Networks.TESTNET,
          context: 'manage_data',
        }),
      ).toThrow('did not match the intended operation');
    });
  });

  describe('InvokeHostFunctionOp operations', () => {
    it('accepts InvokeHostFunctionOp when host function arguments match', () => {
      const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
      const contractId = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
      const contract = new Contract(contractId);

      const intendedTx = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(contract.call('get_will', xdr.ScVal.scvString('test')))
        .setTimeout(30)
        .build();

      expect(() =>
        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: intendedTx.toXDR(),
          preparedTransactionXdr: intendedTx.toXDR(),
          networkPassphrase: Networks.TESTNET,
          context: 'invoke_contract',
        }),
      ).not.toThrow();
    });

    it('throws when operation type changes', () => {
      const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');

      const intendedTx = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'data' }))
        .setTimeout(30)
        .build();

      const differentOp = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'different' }))
        .setTimeout(30)
        .build();

      expect(() =>
        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: intendedTx.toXDR(),
          preparedTransactionXdr: differentOp.toXDR(),
          networkPassphrase: Networks.TESTNET,
          context: 'invoke_contract',
        }),
      ).toThrow('did not match the intended operation');
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #497 — simulation result status validation
// ---------------------------------------------------------------------------
describe('assertPreparedTransactionMatchesIntendedOperation – simulation status check', () => {
  function buildManageDataTx(name: string) {
    const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    return new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name, value: 'payload' }))
      .setTimeout(30)
      .build();
  }

  it('passes when simulationResponse is not provided (backwards-compatible)', () => {
    const tx = buildManageDataTx('sorowill');

    expect(() =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: tx.toXDR(),
        preparedTransactionXdr: tx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'manage_data',
        // no simulationResponse → old callers unaffected
      }),
    ).not.toThrow();
  });

  it('passes when simulationResponse has status "SUCCESS"', () => {
    const tx = buildManageDataTx('sorowill');

    expect(() =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: tx.toXDR(),
        preparedTransactionXdr: tx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'manage_data',
        simulationResponse: { status: 'SUCCESS' },
      }),
    ).not.toThrow();
  });

  it('throws SimulationResultError when simulationResponse has status "ERROR"', () => {
    const tx = buildManageDataTx('sorowill');

    expect(() =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: tx.toXDR(),
        preparedTransactionXdr: tx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'create_will',
        simulationResponse: { status: 'ERROR', error: 'contract rejected the call' },
      }),
    ).toThrow(SimulationResultError);
  });

  it('throws SimulationResultError when simulationResponse has status "FAILED"', () => {
    const tx = buildManageDataTx('sorowill');

    expect(() =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: tx.toXDR(),
        preparedTransactionXdr: tx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'check_in',
        simulationResponse: { status: 'FAILED' },
      }),
    ).toThrow(SimulationResultError);
  });

  it('SimulationResultError carries simulationStatus and simulationError as typed properties', () => {
    const tx = buildManageDataTx('sorowill');

    try {
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: tx.toXDR(),
        preparedTransactionXdr: tx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'create_will',
        simulationResponse: { status: 'ERROR', error: 'contract execution failed' },
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(SimulationResultError);
      // sensitive data lives in properties, NOT embedded in message
      expect(err.message).not.toContain('contract execution failed');
      expect(err.simulationStatus).toBe('ERROR');
      expect(err.simulationError).toBe('contract execution failed');
    }
  });

  it('does not embed the raw simulation error in the message (privacy)', () => {
    const tx = buildManageDataTx('sorowill');
    const sensitiveDetail = 'HostError: Value(Contract, #42) GCUSTOMER_ADDRESS';

    try {
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: tx.toXDR(),
        preparedTransactionXdr: tx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'top_up',
        simulationResponse: { status: 'ERROR', error: sensitiveDetail },
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).not.toContain(sensitiveDetail);
      expect(err.simulationError).toBe(sensitiveDetail);
    }
  });

  it('throws SimulationResultError before structural validation when simulation failed', () => {
    // Even if the XDRs structurally match, a failed simulation should still throw.
    const tx = buildManageDataTx('sorowill');

    expect(() =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: tx.toXDR(),
        preparedTransactionXdr: tx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'release_inheritance',
        simulationResponse: { status: 'ERROR' },
      }),
    ).toThrow(SimulationResultError);
  });

  it('still performs structural validation after a SUCCESS status', () => {
    const intendedTx = buildManageDataTx('sorowill');
    const mismatchedTx = buildManageDataTx('tampered');

    expect(() =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: intendedTx.toXDR(),
        preparedTransactionXdr: mismatchedTx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'manage_data',
        simulationResponse: { status: 'SUCCESS' },
      }),
    ).toThrow('did not match the intended operation');
  });
});

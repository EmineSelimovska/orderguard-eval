import { createMockPaymentProvider } from '../src/provider/mock-payment-provider.js';

describe('Mock Payment Provider', () => {
  let provider;

  beforeEach(() => {
    provider = createMockPaymentProvider();
  });

  test('records one successful charge and returns its original result on retry', async () => {
    provider.configureChargeOutcome('run-1', 'op-1', 'success');

    const result = await provider.charge('run-1', 'op-1', 2500, 'USD');
    const retry = await provider.charge('run-1', 'op-1', 2500, 'USD');

    expect(retry).toEqual(result);
    expect(provider.inspectLedger('run-1')).toMatchObject({
      operations: [{
        operationKey: 'op-1',
        status: 'succeeded',
        attemptCount: 2,
      }],
      captures: [{
        operationKey: 'op-1',
        amountMinor: 2500,
        currency: 'USD',
      }],
      refunds: [],
    });
    expect(provider.inspectLedger('run-1').captures).toHaveLength(1);
  });

  test('records a decline without creating a capture', async () => {
    provider.configureChargeOutcome('run-1', 'op-decline', 'decline');

    await expect(provider.charge('run-1', 'op-decline', 1000, 'EUR'))
      .resolves.toMatchObject({ status: 'declined' });
    expect(provider.inspectLedger('run-1').captures).toEqual([]);
  });

  test('allows a retry after timeout before processing to complete the charge', async () => {
    provider.configureChargeOutcome('run-1', 'op-timeout', 'timeout_before_processing');

    await expect(provider.charge('run-1', 'op-timeout', 1000, 'USD'))
      .rejects.toMatchObject({ code: 'NOT_PROCESSED', status: 504 });
    expect(provider.inspectLedger('run-1').captures).toEqual([]);

    await expect(provider.charge('run-1', 'op-timeout', 1000, 'USD'))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect(provider.inspectLedger('run-1').captures).toHaveLength(1);
    expect(provider.inspectLedger('run-1').operations[0]).toMatchObject({
      outcome: 'success',
      attemptCount: 2,
    });
  });

  test('stores capture before simulating processed response timeout and replays success', async () => {
    provider.configureChargeOutcome('run-1', 'op-ambiguous', 'processed_response_timeout');

    await expect(provider.charge('run-1', 'op-ambiguous', 500, 'GBP'))
      .rejects.toMatchObject({
        code: 'PROCESSED_RESPONSE_TIMEOUT',
        status: 504,
        outcome: 'unknown',
      });
    const captureBeforeRetry = provider.inspectLedger('run-1').captures[0];
    const retry = await provider.charge('run-1', 'op-ambiguous', 500, 'GBP');

    expect(retry).toMatchObject({
      status: 'succeeded',
      providerReference: captureBeforeRetry.providerReference,
    });
    expect(provider.inspectLedger('run-1').captures).toHaveLength(1);
    expect(provider.inspectLedger('run-1').operations[0]).toMatchObject({
      outcome: 'processed_response_timeout',
      attemptCount: 2,
    });
  });

  test('rejects charge-key reuse with a different amount or currency', async () => {
    await provider.charge('run-1', 'op-1', 2500, 'USD');

    await expect(provider.charge('run-1', 'op-1', 2501, 'USD'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    await expect(provider.charge('run-1', 'op-1', 2500, 'EUR'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(provider.inspectLedger('run-1').captures).toHaveLength(1);
  });

  test('scopes charge keys and ledger inspection by run', async () => {
    const firstRun = await provider.charge('run-1', 'op-1', 2500, 'USD');
    const secondRun = await provider.charge('run-2', 'op-1', 1500, 'EUR');

    expect(secondRun.runId).toBe('run-2');
    expect(firstRun.providerReference).not.toBe(secondRun.providerReference);
    expect(provider.inspectLedger('run-1').captures).toHaveLength(1);
    expect(provider.inspectLedger('run-2').captures).toHaveLength(1);
  });

  test('refunds a capture once and returns the original refund on retry', async () => {
    await provider.charge('run-1', 'op-1', 2500, 'USD');

    const refund = await provider.refund('run-1', 'refund-1', 'op-1');
    const retry = await provider.refund('run-1', 'refund-1', 'op-1');

    expect(retry).toEqual(refund);
    expect(refund).toMatchObject({
      status: 'refunded',
      amountMinor: 2500,
      currency: 'USD',
    });
    expect(provider.inspectLedger('run-1').refunds).toHaveLength(1);
  });

  test('rejects refund-key reuse and a second refund for the same capture', async () => {
    await provider.charge('run-1', 'op-1', 2500, 'USD');
    await provider.refund('run-1', 'refund-1', 'op-1');

    await expect(provider.refund('run-1', 'refund-1', 'op-other'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    await expect(provider.refund('run-1', 'refund-2', 'op-1'))
      .rejects.toMatchObject({ code: 'REFUND_ALREADY_PROCESSED', status: 409 });
    expect(provider.inspectLedger('run-1').refunds).toHaveLength(1);
  });

  test('scopes the same refund operation key independently by run', async () => {
    await provider.charge('run-1', 'op-1', 2500, 'USD');
    await provider.charge('run-2', 'op-1', 2500, 'USD');

    const firstRunRefund = await provider.refund('run-1', 'refund-1', 'op-1');
    const secondRunRefund = await provider.refund('run-2', 'refund-1', 'op-1');

    expect(firstRunRefund.runId).toBe('run-1');
    expect(secondRunRefund.runId).toBe('run-2');
    expect(provider.inspectLedger('run-1').refunds).toHaveLength(1);
    expect(provider.inspectLedger('run-2').refunds).toHaveLength(1);
  });

  test('does not resolve a charge from another run when refunding', async () => {
    await provider.charge('run-2', 'op-1', 2500, 'USD');

    await expect(provider.refund('run-1', 'refund-1', 'op-1'))
      .rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND', status: 404 });
    expect(provider.inspectLedger('run-1').refunds).toEqual([]);
    expect(provider.inspectLedger('run-2').refunds).toEqual([]);
  });

  test('clears refund records and deduplication state for only the selected run', async () => {
    await provider.charge('run-1', 'op-1', 1000, 'USD');
    await provider.charge('run-2', 'op-2', 2000, 'USD');
    await provider.refund('run-1', 'refund-1', 'op-1');
    const otherRunRefund = await provider.refund('run-2', 'refund-1', 'op-2');

    provider.clearRun('run-1');

    expect(provider.inspectLedger('run-1')).toEqual({
      runId: 'run-1',
      operations: [],
      captures: [],
      refunds: [],
    });
    expect(provider.inspectLedger('run-2').refunds).toEqual([otherRunRefund]);

    await provider.charge('run-1', 'op-1', 1000, 'USD');
    await expect(provider.refund('run-1', 'refund-1', 'op-1'))
      .resolves.toMatchObject({
        runId: 'run-1',
        refundOperationKey: 'refund-1',
        originalOperationKey: 'op-1',
        status: 'refunded',
      });
    expect(provider.inspectLedger('run-2').refunds).toEqual([otherRunRefund]);
  });

  test('rejects refunding an unknown or uncaptured operation', async () => {
    await expect(provider.refund('run-1', 'refund-1', 'missing'))
      .rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND', status: 404 });

    provider.configureChargeOutcome('run-1', 'op-decline', 'decline');
    await provider.charge('run-1', 'op-decline', 1000, 'USD');
    await expect(provider.refund('run-1', 'refund-2', 'op-decline'))
      .rejects.toMatchObject({ code: 'REFUND_NOT_ALLOWED', status: 409 });
  });

  test('rejects outcome configuration once an operation has started', async () => {
    await provider.charge('run-1', 'op-1', 1000, 'USD');

    expect(() => provider.configureChargeOutcome('run-1', 'op-1', 'decline'))
      .toThrow('Charge outcome must be configured before the operation starts');
  });

  test('returns detached, run-scoped ledger snapshots and clears only the selected run', async () => {
    await provider.charge('run-1', 'op-1', 1000, 'USD');
    await provider.charge('run-2', 'op-2', 2000, 'USD');

    const snapshot = provider.inspectLedger('run-1');
    snapshot.captures[0].amountMinor = 99;
    expect(provider.inspectLedger('run-1').captures[0].amountMinor).toBe(1000);

    provider.clearRun('run-1');
    expect(provider.inspectLedger('run-1')).toEqual({
      runId: 'run-1',
      operations: [],
      captures: [],
      refunds: [],
    });
    expect(provider.inspectLedger('run-2').captures).toHaveLength(1);
  });

  test('clears configured outcomes that have not started', async () => {
    provider.configureChargeOutcome('run-1', 'op-1', 'decline');
    provider.clearRun('run-1');
    provider.configureChargeOutcome('run-1', 'op-1', 'success');

    await expect(provider.charge('run-1', 'op-1', 1000, 'USD'))
      .resolves.toMatchObject({ status: 'succeeded' });
  });
});

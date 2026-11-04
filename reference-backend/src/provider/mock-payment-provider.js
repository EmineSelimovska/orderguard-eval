import { createHash } from 'node:crypto';

const CHARGE_OUTCOMES = new Set([
  'success',
  'decline',
  'timeout_before_processing',
  'processed_response_timeout',
]);
const SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP']);

export class MockPaymentProviderError extends Error {
  constructor(code, status, message, { outcome } = {}) {
    super(message);
    this.name = 'MockPaymentProviderError';
    this.code = code;
    this.status = status;
    if (outcome) {
      this.outcome = outcome;
    }
  }
}

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MockPaymentProviderError(
      'INVALID_REQUEST',
      400,
      `${name} must be a non-empty string`,
    );
  }
}

function identity(runId, operationKey) {
  return JSON.stringify([runId, operationKey]);
}

function providerReference(prefix, runId, operationKey) {
  const digest = createHash('sha256')
    .update(JSON.stringify([runId, operationKey]))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function clone(record) {
  return { ...record };
}

export function createMockPaymentProvider() {
  const operations = new Map();
  const captures = new Map();
  const refunds = new Map();
  const outcomes = new Map();
  const refundedOperations = new Map();

  function validateCharge({ runId, operationKey, amountMinor, currency }) {
    assertIdentifier(runId, 'runId');
    assertIdentifier(operationKey, 'operationKey');

    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new MockPaymentProviderError(
        'VALIDATION_ERROR',
        422,
        'amountMinor must be a non-negative safe integer',
      );
    }

    if (!SUPPORTED_CURRENCIES.has(currency)) {
      throw new MockPaymentProviderError(
        'VALIDATION_ERROR',
        422,
        'currency is not supported',
      );
    }
  }

  function chargeResult(operation) {
    return {
      runId: operation.runId,
      operationKey: operation.operationKey,
      status: operation.status,
      providerReference: operation.providerReference,
    };
  }

  async function charge(runId, operationKey, amountMinor, currency) {
    const request = { runId, operationKey, amountMinor, currency };
    validateCharge(request);

    const key = identity(runId, operationKey);
    let operation = operations.get(key);
    if (operation) {
      if (
        operation.amountMinor !== amountMinor
        || operation.currency !== currency
      ) {
        throw new MockPaymentProviderError(
          'IDEMPOTENCY_CONFLICT',
          409,
          'Operation key was reused with a different charge',
        );
      }

      if (operation.status !== 'not_processed') {
        operation.attemptCount += 1;
        return chargeResult(operation);
      }
    } else {
      operation = {
        runId,
        operationKey,
        amountMinor,
        currency,
        status: 'not_processed',
        outcome: null,
        attemptCount: 0,
        providerReference: null,
      };
      operations.set(key, operation);
    }

    operation.attemptCount += 1;
    const configuredOutcome = outcomes.get(key) ?? 'success';
    outcomes.delete(key);

    if (configuredOutcome === 'timeout_before_processing') {
      operation.outcome = configuredOutcome;
      throw new MockPaymentProviderError(
        'NOT_PROCESSED',
        504,
        'Charge timed out before processing',
      );
    }

    operation.providerReference = providerReference('provider_charge', runId, operationKey);
    operation.outcome = configuredOutcome;
    operation.status = configuredOutcome === 'decline' ? 'declined' : 'succeeded';

    if (operation.status === 'succeeded') {
      captures.set(key, {
        runId,
        operationKey,
        amountMinor,
        currency,
        providerReference: operation.providerReference,
      });
    }

    if (configuredOutcome === 'processed_response_timeout') {
      throw new MockPaymentProviderError(
        'PROCESSED_RESPONSE_TIMEOUT',
        504,
        'Charge was processed but the response was lost',
        { outcome: 'unknown' },
      );
    }

    return chargeResult(operation);
  }

  async function refund(runId, refundOperationKey, originalOperationKey) {
    assertIdentifier(runId, 'runId');
    assertIdentifier(refundOperationKey, 'refundOperationKey');
    assertIdentifier(originalOperationKey, 'originalOperationKey');

    const refundKey = identity(runId, refundOperationKey);
    const existingRefund = refunds.get(refundKey);
    if (existingRefund) {
      if (existingRefund.originalOperationKey !== originalOperationKey) {
        throw new MockPaymentProviderError(
          'IDEMPOTENCY_CONFLICT',
          409,
          'Refund key was reused for a different charge',
        );
      }

      return clone(existingRefund);
    }

    const originalKey = identity(runId, originalOperationKey);
    const capture = captures.get(originalKey);
    if (!capture) {
      const originalOperation = operations.get(originalKey);
      if (!originalOperation) {
        throw new MockPaymentProviderError(
          'OPERATION_NOT_FOUND',
          404,
          'Original charge was not found',
        );
      }

      throw new MockPaymentProviderError(
        'REFUND_NOT_ALLOWED',
        409,
        'Original charge was not captured',
      );
    }

    const priorRefundKey = refundedOperations.get(originalKey);
    if (priorRefundKey) {
      throw new MockPaymentProviderError(
        'REFUND_ALREADY_PROCESSED',
        409,
        'Original charge has already been refunded',
      );
    }

    const result = {
      runId,
      refundOperationKey,
      originalOperationKey,
      status: 'refunded',
      amountMinor: capture.amountMinor,
      currency: capture.currency,
      providerReference: providerReference('provider_refund', runId, refundOperationKey),
    };
    refunds.set(refundKey, result);
    refundedOperations.set(originalKey, refundKey);
    return clone(result);
  }

  function configureChargeOutcome(runId, operationKey, outcome) {
    assertIdentifier(runId, 'runId');
    assertIdentifier(operationKey, 'operationKey');
    if (!CHARGE_OUTCOMES.has(outcome)) {
      throw new MockPaymentProviderError(
        'INVALID_REQUEST',
        400,
        'Unsupported charge outcome',
      );
    }

    const key = identity(runId, operationKey);
    if (operations.has(key)) {
      throw new MockPaymentProviderError(
        'OPERATION_ALREADY_STARTED',
        409,
        'Charge outcome must be configured before the operation starts',
      );
    }

    outcomes.set(key, outcome);
  }

  function inspectLedger(runId) {
    assertIdentifier(runId, 'runId');
    const inRun = (record) => record.runId === runId;
    return {
      runId,
      operations: [...operations.values()].filter(inRun).map(clone),
      captures: [...captures.values()].filter(inRun).map(clone),
      refunds: [...refunds.values()].filter(inRun).map(clone),
    };
  }

  function clearRun(runId) {
    assertIdentifier(runId, 'runId');
    for (const [key, operation] of operations) {
      if (operation.runId === runId) {
        operations.delete(key);
        captures.delete(key);
      }
    }
    for (const key of outcomes.keys()) {
      if (JSON.parse(key)[0] === runId) {
        outcomes.delete(key);
      }
    }
    for (const [key, refundRecord] of refunds) {
      if (refundRecord.runId === runId) {
        refunds.delete(key);
      }
    }
    for (const key of refundedOperations.keys()) {
      if (JSON.parse(key)[0] === runId) {
        refundedOperations.delete(key);
      }
    }
  }

  return {
    charge,
    refund,
    configureChargeOutcome,
    inspectLedger,
    clearRun,
  };
}

import { createHash } from 'node:crypto';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CURRENCIES = new Set(['USD', 'EUR', 'GBP']);
const CHARGE_OUTCOMES = new Set([
  'success',
  'decline',
  'timeout_before_processing',
  'processed_response_timeout',
]);
const REFUND_OUTCOMES = new Set(['success', 'processed_response_timeout']);
const CHARGE_GATES = new Set(['before_processing', 'after_capture_before_response']);
const REFUND_GATES = new Set(['before_refund', 'after_refund_before_response']);
const MAX_AMOUNT_MINOR = 100000000;

export class MockProviderError extends Error {
  constructor(code, status, message, { transportLost = false, responseBody } = {}) {
    super(message);
    this.name = 'MockProviderError';
    this.code = code;
    this.status = status;
    this.transportLost = transportLost;
    this.responseBody = responseBody;
  }
}

function requireIdentifier(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MockProviderError('INVALID_REQUEST', 400, `${name} must be a non-empty string`);
  }
}

function requireRunId(runId) {
  requireIdentifier(runId, 'runId');
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new MockProviderError('INVALID_REQUEST', 400, 'runId is invalid');
  }
}

function requireCharge({ runId, operationKey, amountMinor, currency }) {
  requireRunId(runId);
  requireIdentifier(operationKey, 'operationKey');
  if (
    !Number.isSafeInteger(amountMinor)
    || amountMinor < 0
    || amountMinor > MAX_AMOUNT_MINOR
    || !CURRENCIES.has(currency)
  ) {
    throw new MockProviderError(
      'VALIDATION_ERROR',
      422,
      'amountMinor or currency is invalid',
    );
  }
}

function providerReference(prefix, runId, key) {
  const digest = createHash('sha256')
    .update(JSON.stringify([runId, key]), 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function copy(record) {
  return { ...record };
}

function defaultPlan() {
  return {
    chargeOutcome: 'success',
    holdAt: null,
    refundOutcome: 'success',
    refundHoldAt: null,
  };
}

function createRun(runId) {
  return {
    runId,
    operations: new Map(),
    captures: new Map(),
    refunds: new Map(),
    pendingRefunds: new Map(),
    refundedOperations: new Map(),
    plans: new Map(),
    gates: new Map(),
    locks: new Map(),
    activeRequests: 0,
  };
}

function enqueue(run, key, callback) {
  const previous = run.locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  run.locks.set(key, current);

  return (async () => {
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (run.locks.get(key) === current) {
        run.locks.delete(key);
      }
    }
  })();
}

export function createMockProvider() {
  const runs = new Map();

  function getRun(runId, create = false) {
    let run = runs.get(runId);
    if (!run && create) {
      run = createRun(runId);
      runs.set(runId, run);
    }
    return run;
  }

  function beginRequest(runId) {
    requireRunId(runId);
    const run = getRun(runId, true);
    run.activeRequests += 1;
    let ended = false;
    return () => {
      if (!ended) {
        ended = true;
        run.activeRequests -= 1;
      }
    };
  }

  function waitAtGate(run, key, target, phase) {
    const gateKey = JSON.stringify([key, phase]);
    let gate = run.gates.get(gateKey);
    if (!gate) {
      gate = { released: false, waiters: [] };
      run.gates.set(gateKey, gate);
    }
    target.waitingAt = phase;
    if (gate.released) {
      target.waitingAt = null;
      run.gates.delete(gateKey);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      gate.waiters.push(() => {
        target.waitingAt = null;
        run.gates.delete(gateKey);
        resolve();
      });
    });
  }

  function configureOperation(runId, operationKey, input = {}) {
    requireRunId(runId);
    requireIdentifier(operationKey, 'operationKey');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new MockProviderError('INVALID_REQUEST', 400, 'Operation plan must be an object');
    }

    const allowedFields = new Set([
      'chargeOutcome',
      'holdAt',
      'refundOutcome',
      'refundHoldAt',
    ]);
    if (Object.keys(input).some((field) => !allowedFields.has(field))) {
      throw new MockProviderError('INVALID_REQUEST', 400, 'Operation plan has unknown fields');
    }

    const plan = {
      chargeOutcome: input.chargeOutcome,
      holdAt: input.holdAt ?? null,
      refundOutcome: input.refundOutcome ?? 'success',
      refundHoldAt: input.refundHoldAt ?? null,
    };
    if (
      !CHARGE_OUTCOMES.has(plan.chargeOutcome)
      || (plan.holdAt !== null && !CHARGE_GATES.has(plan.holdAt))
      || !REFUND_OUTCOMES.has(plan.refundOutcome)
      || (plan.refundHoldAt !== null && !REFUND_GATES.has(plan.refundHoldAt))
      || (
        plan.holdAt === 'after_capture_before_response'
        && !['success', 'processed_response_timeout'].includes(plan.chargeOutcome)
      )
    ) {
      throw new MockProviderError('INVALID_REQUEST', 400, 'Operation plan is invalid');
    }

    const run = getRun(runId, true);
    const existing = run.plans.get(operationKey);
    if (existing && JSON.stringify(existing) === JSON.stringify(plan)) {
      return { status: 200, runId, operationKey };
    }
    if (run.operations.has(operationKey)) {
      throw new MockProviderError(
        'OPERATION_ALREADY_STARTED',
        409,
        'Operation plan cannot change after the charge starts',
      );
    }

    run.plans.set(operationKey, plan);
    return { status: existing ? 200 : 201, runId, operationKey };
  }

  function releaseOperationGate(runId, operationKey, phase) {
    requireRunId(runId);
    requireIdentifier(operationKey, 'operationKey');
    const run = getRun(runId);
    const operation = run?.operations.get(operationKey);
    if (!operation) {
      throw new MockProviderError('NOT_FOUND', 404, 'Operation was not found');
    }

    let target;
    if (CHARGE_GATES.has(phase) && operation.waitingAt === phase) {
      target = operation;
    } else if (phase === 'before_refund') {
      target = [...run.pendingRefunds.values()].find((refund) => (
        refund.originalOperationKey === operationKey
        && refund.waitingAt === phase
      ));
    } else if (phase === 'after_refund_before_response') {
      target = [...run.refunds.values()].find((refund) => (
        refund.originalOperationKey === operationKey
        && refund.waitingAt === phase
      ));
    }
    if (!target) {
      throw new MockProviderError('GATE_NOT_HELD', 409, 'The requested provider gate is not held');
    }

    const gateKey = JSON.stringify([operationKey, phase]);
    const gate = run.gates.get(gateKey);
    if (!gate || gate.released) {
      throw new MockProviderError('GATE_NOT_HELD', 409, 'The requested provider gate is not held');
    }
    gate.released = true;
    for (const resolve of gate.waiters.splice(0)) {
      resolve();
    }
    return { runId, operationKey, phase, released: true };
  }

  async function charge(runId, operationKey, amountMinor, currency) {
    requireCharge({ runId, operationKey, amountMinor, currency });
    const endRequest = beginRequest(runId);
    const run = getRun(runId);
    try {
      return await enqueue(run, `charge:${operationKey}`, async () => {
        let operation = run.operations.get(operationKey);
        if (operation && (
          operation.amountMinor !== amountMinor
          || operation.currency !== currency
        )) {
          throw new MockProviderError(
            'IDEMPOTENCY_CONFLICT',
            409,
            'Operation key was reused with a different charge',
          );
        }

        if (operation && ['succeeded', 'declined'].includes(operation.status)) {
          operation.attemptCount += 1;
          return chargeResult(operation);
        }

        if (!operation) {
          operation = {
            runId,
            operationKey,
            amountMinor,
            currency,
            status: 'processing',
            outcome: null,
            attemptCount: 0,
            providerReference: null,
            waitingAt: null,
            chargeOutcomeConsumed: false,
            createdAt: new Date(),
          };
          run.operations.set(operationKey, operation);
        }

        operation.status = 'processing';
        operation.attemptCount += 1;
        const plan = run.plans.get(operationKey) ?? defaultPlan();
        const firstPlannedAttempt = !operation.chargeOutcomeConsumed;

        if (firstPlannedAttempt && plan.holdAt === 'before_processing') {
          await waitAtGate(run, operationKey, operation, 'before_processing');
        }

        const outcome = firstPlannedAttempt ? plan.chargeOutcome : 'success';
        operation.chargeOutcomeConsumed = true;
        operation.outcome = outcome;

        if (outcome === 'timeout_before_processing') {
          operation.status = 'not_processed';
          throw new MockProviderError(
            'NOT_PROCESSED',
            504,
            'Charge timed out before processing',
            { responseBody: { code: 'NOT_PROCESSED', runId, operationKey } },
          );
        }

        operation.providerReference = providerReference('provider_charge', runId, operationKey);
        operation.status = outcome === 'decline' ? 'declined' : 'succeeded';
        operation.processedAt = new Date();
        if (operation.status === 'succeeded') {
          run.captures.set(operationKey, {
            runId,
            operationKey,
            amountMinor,
            currency,
            providerReference: operation.providerReference,
            capturedAt: operation.processedAt,
          });
        }

        if (firstPlannedAttempt && plan.holdAt === 'after_capture_before_response') {
          await waitAtGate(run, operationKey, operation, 'after_capture_before_response');
        }

        if (outcome === 'processed_response_timeout') {
          throw new MockProviderError(
            'PROCESSED_RESPONSE_TIMEOUT',
            504,
            'Charge was processed but the response was lost',
            { transportLost: true },
          );
        }
        return chargeResult(operation);
      });
    } finally {
      endRequest();
    }
  }

  async function refund(runId, refundOperationKey, originalOperationKey) {
    requireRunId(runId);
    requireIdentifier(refundOperationKey, 'refundOperationKey');
    requireIdentifier(originalOperationKey, 'originalOperationKey');
    const endRequest = beginRequest(runId);
    const run = getRun(runId);
    try {
      return await enqueue(run, `refund:${originalOperationKey}`, async () => {
        const existing = run.refunds.get(refundOperationKey);
        if (existing) {
          if (existing.originalOperationKey !== originalOperationKey) {
            throw new MockProviderError(
              'IDEMPOTENCY_CONFLICT',
              409,
              'Refund key was reused for a different charge',
            );
          }
          if (existing.status === 'refunded') {
            return refundResult(existing);
          }
        }

        const capture = run.captures.get(originalOperationKey);
        if (!capture) {
          if (!run.operations.has(originalOperationKey)) {
            throw new MockProviderError('OPERATION_NOT_FOUND', 404, 'Original charge was not found');
          }
          throw new MockProviderError('REFUND_NOT_ALLOWED', 409, 'Original charge was not captured');
        }

        const priorRefundKey = run.refundedOperations.get(originalOperationKey);
        if (priorRefundKey && priorRefundKey !== refundOperationKey) {
          throw new MockProviderError(
            'REFUND_ALREADY_PROCESSED',
            409,
            'Original charge has already been refunded',
          );
        }

        const plan = run.plans.get(originalOperationKey) ?? defaultPlan();
        const refundRecord = existing ?? {
          runId,
          refundOperationKey,
          originalOperationKey,
          status: 'processing',
          amountMinor: capture.amountMinor,
          currency: capture.currency,
          providerReference: null,
          waitingAt: null,
          createdAt: new Date(),
        };
        refundRecord.status = 'processing';
        refundRecord.waitingAt = null;
        run.pendingRefunds.set(refundOperationKey, refundRecord);

        try {
          if (plan.refundHoldAt === 'before_refund') {
            await waitAtGate(run, originalOperationKey, refundRecord, 'before_refund');
          }

          refundRecord.status = 'refunded';
          refundRecord.providerReference = providerReference(
            'provider_refund',
            runId,
            refundOperationKey,
          );
          refundRecord.refundedAt = new Date();
          run.pendingRefunds.delete(refundOperationKey);
          run.refunds.set(refundOperationKey, refundRecord);
          run.refundedOperations.set(originalOperationKey, refundOperationKey);

          if (plan.refundHoldAt === 'after_refund_before_response') {
            await waitAtGate(
              run,
              originalOperationKey,
              refundRecord,
              'after_refund_before_response',
            );
          }

          if (plan.refundOutcome === 'processed_response_timeout') {
            throw new MockProviderError(
              'PROCESSED_RESPONSE_TIMEOUT',
              504,
              'Refund was processed but the response was lost',
              { transportLost: true },
            );
          }
          return refundResult(refundRecord);
        } catch (error) {
          if (run.pendingRefunds.get(refundOperationKey) === refundRecord) {
            run.pendingRefunds.delete(refundOperationKey);
          }
          throw error;
        }
      });
    } finally {
      endRequest();
    }
  }

  function getLedger(runId) {
    requireRunId(runId);
    const run = getRun(runId);
    if (!run) {
      return { runId, operations: [], captures: [], refunds: [], pendingRefunds: [] };
    }
    return {
      runId,
      operations: [...run.operations.values()]
        .sort((left, right) => left.operationKey.localeCompare(right.operationKey))
        .map((record) => ({
          runId: record.runId,
          operationKey: record.operationKey,
          status: record.status,
          amountMinor: record.amountMinor,
          currency: record.currency,
          outcome: record.outcome,
          attemptCount: record.attemptCount,
          providerReference: record.providerReference,
          ...(record.waitingAt ? { waitingAt: record.waitingAt } : {}),
          ...(record.createdAt ? { createdAt: record.createdAt } : {}),
          ...(record.processedAt ? { processedAt: record.processedAt } : {}),
        })),
      captures: [...run.captures.values()]
        .sort((left, right) => left.operationKey.localeCompare(right.operationKey))
        .map(copy),
      refunds: [...run.refunds.values()]
        .sort((left, right) => left.refundOperationKey.localeCompare(right.refundOperationKey))
        .map((record) => ({
          runId: record.runId,
          refundOperationKey: record.refundOperationKey,
          originalOperationKey: record.originalOperationKey,
          status: record.status,
          amountMinor: record.amountMinor,
          currency: record.currency,
          providerReference: record.providerReference,
          ...(record.waitingAt ? { waitingAt: record.waitingAt } : {}),
          ...(record.createdAt ? { createdAt: record.createdAt } : {}),
          ...(record.refundedAt ? { refundedAt: record.refundedAt } : {}),
        })),
      pendingRefunds: [...run.pendingRefunds.values()]
        .sort((left, right) => left.refundOperationKey.localeCompare(right.refundOperationKey))
        .map((record) => ({
          runId: record.runId,
          refundOperationKey: record.refundOperationKey,
          originalOperationKey: record.originalOperationKey,
          status: record.status,
          amountMinor: record.amountMinor,
          currency: record.currency,
          ...(record.waitingAt ? { waitingAt: record.waitingAt } : {}),
          ...(record.createdAt ? { createdAt: record.createdAt } : {}),
        })),
    };
  }

  function clearRun(runId) {
    requireRunId(runId);
    const run = getRun(runId);
    if (!run) {
      return true;
    }
    const unfinished = [...run.operations.values()].some((record) => record.status === 'processing')
      || run.pendingRefunds.size > 0;
    if (run.activeRequests > 0 || unfinished) {
      return false;
    }
    return runs.delete(runId);
  }

  return {
    charge,
    refund,
    configureOperation,
    releaseOperationGate,
    getLedger,
    clearRun,
  };
}

function chargeResult(operation) {
  return {
    runId: operation.runId,
    operationKey: operation.operationKey,
    status: operation.status,
    providerReference: operation.providerReference,
  };
}

function refundResult(refund) {
  return {
    runId: refund.runId,
    refundOperationKey: refund.refundOperationKey,
    originalOperationKey: refund.originalOperationKey,
    status: 'refunded',
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    providerReference: refund.providerReference,
  };
}
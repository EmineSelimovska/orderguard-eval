import { jest } from '@jest/globals';
import {
  attemptPayment,
  PaymentAttemptAlreadyClaimedError,
  PaymentOutcomeConflictError,
  PaymentOrderNotFoundError,
  PaymentOrderNotPayableError,
  PaymentRecordMissingError,
  preparePaymentAttempt,
} from '../src/services/payments.js';

const runId = 'run-1';
const orderId = 'order-1';
const order = {
  _id: orderId,
  runId,
  paymentId: 'payment-1',
  status: 'pending_payment',
  inventoryDisposition: 'held',
  version: 0,
  amountMinor: 2500,
  currency: 'USD',
  items: [{ productId: 'product-1', quantity: 2 }],
};
const payment = {
  _id: 'payment-1',
  runId,
  orderId,
  operationKey: 'op-stable-1',
  amountMinor: 2500,
  currency: 'USD',
  status: 'pending',
  attemptCount: 0,
};

function createTransactionSupport(state, events, { retryClaimOnce = false } = {}) {
  let transactionTail = Promise.resolve();
  let retryAvailable = retryClaimOnce;

  function restoreState(snapshot) {
    for (const key of Object.keys(state)) {
      state[key] = structuredClone(snapshot[key]);
    }
  }

  async function withTransaction(session, callback) {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      let callbackAttempt = 0;
      while (true) {
        const snapshot = structuredClone(state);
        events.push('claim-transaction-start');
        try {
          const result = await callback(session);
          if (retryAvailable && callbackAttempt === 0) {
            retryAvailable = false;
            restoreState(snapshot);
            callbackAttempt += 1;
            events.push('claim-callback-retried');
            continue;
          }
          events.push('claim-transaction-commit');
          return result;
        } catch (error) {
          restoreState(snapshot);
          events.push('claim-transaction-abort');
          throw error;
        }
      }
    } finally {
      release();
    }
  }

  function createSession() {
    let snapshot;
    let active = false;
    const session = {
      withTransaction: jest.fn((callback) => withTransaction(session, callback)),
      startTransaction: jest.fn(async () => {
        snapshot = structuredClone(state);
        active = true;
        events.push('outcome-transaction-start');
      }),
      commitTransaction: jest.fn(async () => {
        active = false;
        events.push('outcome-transaction-commit');
      }),
      abortTransaction: jest.fn(async () => {
        restoreState(snapshot);
        active = false;
        events.push('outcome-transaction-abort');
      }),
      inTransaction: jest.fn(() => active),
      endSession: jest.fn(),
    };
    return session;
  }

  return {
    createSession,
  };
}

function createClaimHarness({
  order: orderOverrides = {},
  payment: paymentOverrides = {},
  retryClaimOnce = false,
} = {}) {
  const state = {
    order: { ...order, ...orderOverrides },
    payment: { ...payment, ...paymentOverrides },
  };
  const events = [];
  const transactionSupport = createTransactionSupport(state, events, { retryClaimOnce });
  const OrderModel = {
    findOne: jest.fn(async () => ({ ...state.order })),
    findOneAndUpdate: jest.fn(async (filter, update) => {
      if (
        state.order.runId !== filter.runId
        || state.order._id !== filter._id
        || state.order.paymentId !== filter.paymentId
        || state.order.status !== filter.status
        || state.order.inventoryDisposition !== filter.inventoryDisposition
        || state.order.version !== filter.version
      ) {
        return null;
      }
      state.order = {
        ...state.order,
        ...update.$set,
        version: state.order.version + update.$inc.version,
      };
      events.push('order-claim');
      return { ...state.order };
    }),
  };
  const PaymentModel = {
    findOne: jest.fn(async () => ({ ...state.payment })),
    findOneAndUpdate: jest.fn(async (filter, update) => {
      if (
        state.payment.runId !== filter.runId
        || state.payment._id !== filter._id
        || state.payment.orderId !== filter.orderId
        || state.payment.status !== filter.status
      ) {
        return null;
      }
      state.payment = {
        ...state.payment,
        ...update.$set,
        ...(update.$inc
          ? { attemptCount: state.payment.attemptCount + update.$inc.attemptCount }
          : {}),
      };
      events.push('payment-claim');
      return { ...state.payment };
    }),
  };
  const startSession = jest.fn(async () => transactionSupport.createSession());

  return {
    state,
    events,
    OrderModel,
    PaymentModel,
    startSession,
    transactionSupport,
  };
}

describe('preparePaymentAttempt', () => {
  test('finds the order and linked payment within the requested run', async () => {
    const models = createClaimHarness();

    await preparePaymentAttempt({ runId, orderId }, models);

    const claimSession = await Promise.resolve(models.startSession.mock.results[0].value);
    expect(models.OrderModel.findOne).toHaveBeenCalledWith(
      { runId, _id: orderId },
      null,
      { session: claimSession },
    );
    expect(models.PaymentModel.findOne).toHaveBeenCalledWith(
      { runId, _id: order.paymentId, orderId: String(order._id) },
      null,
      { session: claimSession },
    );
    expect(models.OrderModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        runId,
        _id: order._id,
        paymentId: payment._id,
        status: 'pending_payment',
        inventoryDisposition: 'held',
        version: 0,
      },
      { $inc: { version: 1 } },
      { new: true, runValidators: true, session: claimSession },
    );
    expect(models.PaymentModel.findOneAndUpdate).toHaveBeenCalledWith(
      { runId, _id: payment._id, orderId, status: 'pending' },
      { $set: { status: 'processing' }, $inc: { attemptCount: 1 } },
      { new: true, runValidators: true, session: claimSession },
    );
  });

  test('returns persisted details and increments attempt count and Order version once', async () => {
    const models = createClaimHarness();

    await expect(preparePaymentAttempt({ runId, orderId }, models))
      .resolves.toEqual({
        order: { ...order, version: 1 },
        payment: { ...payment, status: 'processing', attemptCount: 1 },
        operationKey: 'op-stable-1',
      });

    expect(models.state.order.version).toBe(1);
    expect(models.state.payment.attemptCount).toBe(1);
    expect(models.PaymentModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('does not claim a Payment when the Order is missing from this run', async () => {
    const models = createClaimHarness();
    models.OrderModel.findOne.mockResolvedValue(null);

    await expect(preparePaymentAttempt({ runId, orderId }, models))
      .rejects.toBeInstanceOf(PaymentOrderNotFoundError);

    expect(models.PaymentModel.findOne).not.toHaveBeenCalled();
    expect(models.PaymentModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not claim a Payment that is missing or not linked in this run', async () => {
    const models = createClaimHarness();
    models.PaymentModel.findOne.mockResolvedValue(null);

    await expect(preparePaymentAttempt({ runId, orderId }, models))
      .rejects.toBeInstanceOf(PaymentRecordMissingError);

    expect(models.PaymentModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('claims unknown for retry using the persisted key and charge details', async () => {
    const models = createClaimHarness({
      order: { version: 8 },
      payment: {
        status: 'unknown',
        attemptCount: 3,
        operationKey: 'persisted-operation-key',
        amountMinor: 5100,
        currency: 'EUR',
      },
    });

    const result = await preparePaymentAttempt({ runId, orderId }, models);

    expect(result.operationKey).toBe('persisted-operation-key');
    expect(result.payment).toMatchObject({
      status: 'processing',
      attemptCount: 4,
      amountMinor: 5100,
      currency: 'EUR',
    });
    expect(result.order.version).toBe(9);
    expect(models.PaymentModel.findOneAndUpdate.mock.calls[0][1])
      .not.toHaveProperty('$set.operationKey');
  });

  test.each([
    'processing',
    'succeeded',
    'declined',
    'voided',
    'refund_pending',
    'refunded',
  ])(
    'does not claim a Payment already in %s state',
    async (status) => {
      const models = createClaimHarness({ payment: { status } });

      await expect(preparePaymentAttempt({ runId, orderId }, models))
        .rejects.toBeInstanceOf(PaymentAttemptAlreadyClaimedError);

      expect(models.PaymentModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(models.state.order.version).toBe(0);
    },
  );

  test('does not call claim writes when the linked Order is no longer payable', async () => {
    const models = createClaimHarness({
      order: { status: 'paid', inventoryDisposition: 'consumed' },
    });

    await expect(preparePaymentAttempt({ runId, orderId }, models))
      .rejects.toBeInstanceOf(PaymentOrderNotPayableError);

    expect(models.OrderModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(models.PaymentModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('replayed transaction callback leaves only one committed version and attempt increment', async () => {
    const models = createClaimHarness({ retryClaimOnce: true });

    await preparePaymentAttempt({ runId, orderId }, models);

    expect(models.events.filter((event) => event === 'claim-callback-retried')).toHaveLength(1);
    expect(models.state.order.version).toBe(1);
    expect(models.state.payment.attemptCount).toBe(1);
  });

  function createAttemptDependencies({
    providerResult = {
      runId,
      operationKey: 'op-stable-1',
      status: 'succeeded',
      providerReference: 'provider-charge-1',
    },
    failOrderUpdate = false,
    orderUpdateError,
    failInventoryRelease = false,
    paymentStatus = 'pending',
    attemptCount = 0,
    orderVersion = 0,
    retryClaimOnce = false,
  } = {}) {
    const state = {
      order: { ...order, version: orderVersion },
      payment: {
        ...payment,
        status: paymentStatus,
        attemptCount,
        lastSafeOutcome: paymentStatus === 'unknown' ? 'unknown' : 'pending',
        providerOperationReference: null,
      },
      available: 3,
    };
    const events = [];
    const transactionSupport = createTransactionSupport(state, events, { retryClaimOnce });
    const sessions = [];
    const startSession = jest.fn(async () => {
      const session = transactionSupport.createSession();
      sessions.push(session);
      return session;
    });

    const OrderModel = {
      findOne: jest.fn(async () => ({ ...state.order })),
      findOneAndUpdate: jest.fn(async (filter, update) => {
        if (update.$set?.status) {
          events.push('order-result');
        } else {
          events.push('order-claim');
        }
        if (orderUpdateError && update.$set?.status) {
          throw orderUpdateError;
        }
        if (
          (failOrderUpdate && update.$set?.status)
          || state.order.runId !== filter.runId
          || state.order._id !== filter._id
          || state.order.paymentId !== filter.paymentId
          || state.order.status !== (filter.status ?? state.order.status)
          || state.order.inventoryDisposition !== (
            filter.inventoryDisposition ?? state.order.inventoryDisposition
          )
          || state.order.version !== filter.version
        ) {
          return null;
        }
        state.order = {
          ...state.order,
          ...(update.$set ?? {}),
          version: state.order.version + (update.$inc?.version ?? 0),
        };
        return { ...state.order };
      }),
    };
    const PaymentModel = {
      findOne: jest.fn(async () => ({ ...state.payment })),
      findOneAndUpdate: jest.fn(async (filter, update) => {
        events.push(update.$inc?.attemptCount ? 'payment-claim' : 'payment-result');
        if (
          state.payment.runId !== filter.runId
          || state.payment._id !== filter._id
          || state.payment.orderId !== filter.orderId
          || state.payment.status !== filter.status
        ) {
          return null;
        }
        state.payment = {
          ...state.payment,
          ...(update.$set ?? {}),
          ...(update.$inc
            ? { attemptCount: state.payment.attemptCount + update.$inc.attemptCount }
            : {}),
        };
        return { ...state.payment };
      }),
    };
    const ProductModel = {
      findOneAndUpdate: jest.fn(async (_filter, update) => {
        events.push('inventory-release');
        if (failInventoryRelease) {
          return null;
        }
        state.available += update.$inc.available;
        return { available: state.available };
      }),
    };
    const paymentProvider = {
      charge: jest.fn(async (...args) => {
        events.push('provider-charge');
        expect(state.payment).toMatchObject({
          status: 'processing',
          attemptCount: attemptCount + 1,
        });
        if (providerResult instanceof Error) {
          throw providerResult;
        }
        return { ...providerResult, runId: args[0], operationKey: args[1] };
      }),
    };

    return {
      state,
      events,
      sessions,
      OrderModel,
      PaymentModel,
      ProductModel,
      paymentProvider,
      dependencies: {
        OrderModel,
        PaymentModel,
        ProductModel,
        paymentProvider,
        startSession,
      },
    };
  }

  describe('attemptPayment', () => {
    test('persists processing before calling the shared provider with stable charge data', async () => {
      const mocks = createAttemptDependencies();

      await attemptPayment({ runId, orderId }, mocks.dependencies);

      expect(mocks.events.indexOf('payment-claim'))
        .toBeLessThan(mocks.events.indexOf('provider-charge'));
      expect(mocks.events.indexOf('claim-transaction-commit'))
        .toBeLessThan(mocks.events.indexOf('provider-charge'));
      expect(mocks.paymentProvider.charge).toHaveBeenCalledWith(
        runId,
        'op-stable-1',
        2500,
        'USD',
      );
      expect(mocks.events.indexOf('provider-charge'))
        .toBeLessThan(mocks.events.indexOf('outcome-transaction-start'));
      expect(mocks.OrderModel.findOneAndUpdate.mock.calls[1][0]).toMatchObject({
        version: 1,
        status: 'pending_payment',
        inventoryDisposition: 'held',
      });
    });

    test('retries an unknown payment with the same operation key and persisted charge details', async () => {
      const mocks = createAttemptDependencies({
        paymentStatus: 'unknown',
        attemptCount: 4,
        orderVersion: 6,
      });

      const result = await attemptPayment({ runId, orderId }, mocks.dependencies);

      expect(mocks.paymentProvider.charge).toHaveBeenCalledWith(
        runId,
        'op-stable-1',
        2500,
        'USD',
      );
      expect(result.payment).toMatchObject({ status: 'succeeded', attemptCount: 5 });
      expect(result.order.version).toBe(8);
      expect(mocks.state.order.version).toBe(8);
    });

    test('concurrent attempt requests produce one claim and one provider call', async () => {
      const mocks = createAttemptDependencies();

      const results = await Promise.allSettled([
        attemptPayment({ runId, orderId }, mocks.dependencies),
        attemptPayment({ runId, orderId }, mocks.dependencies),
      ]);

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      expect(mocks.paymentProvider.charge).toHaveBeenCalledTimes(1);
      expect(mocks.state.payment).toMatchObject({
        status: 'succeeded',
        attemptCount: 1,
      });
      expect(mocks.state.order.version).toBe(2);
    });

    test('safely applies success and consumes the held inventory', async () => {
      const mocks = createAttemptDependencies();

      const result = await attemptPayment({ runId, orderId }, mocks.dependencies);

      expect(result.payment).toMatchObject({
        status: 'succeeded',
        lastSafeOutcome: 'succeeded',
        providerOperationReference: 'provider-charge-1',
      });
      expect(result.payment.capturedAt).toBeInstanceOf(Date);
      expect(result.order).toMatchObject({
        status: 'paid',
        inventoryDisposition: 'consumed',
        version: 2,
      });
      expect(mocks.ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mocks.sessions[1].commitTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.sessions[1].abortTransaction).not.toHaveBeenCalled();
    });

    test('safely applies decline and releases held inventory exactly once', async () => {
      const mocks = createAttemptDependencies({
        providerResult: {
          runId,
          operationKey: 'op-stable-1',
          status: 'declined',
          providerReference: 'provider-decline-1',
        },
      });

      const result = await attemptPayment({ runId, orderId }, mocks.dependencies);

      expect(result.payment).toMatchObject({
        status: 'declined',
        lastSafeOutcome: 'declined',
        providerOperationReference: 'provider-decline-1',
      });
      expect(result.order).toMatchObject({
        status: 'payment_failed',
        inventoryDisposition: 'released',
        version: 2,
      });
      expect(mocks.ProductModel.findOneAndUpdate).toHaveBeenCalledWith(
        { runId, _id: 'product-1' },
        { $inc: { available: 2 } },
        { new: true, runValidators: true, session: mocks.sessions[1] },
      );
      expect(mocks.state.available).toBe(5);
      expect(mocks.sessions[1].commitTransaction).toHaveBeenCalledTimes(1);
    });

    test('returns a known not-processed timeout to pending without recording a decline', async () => {
      const providerError = Object.assign(new Error('Charge was not processed'), {
        code: 'NOT_PROCESSED',
      });
      const mocks = createAttemptDependencies({ providerResult: providerError });

      const result = await attemptPayment({ runId, orderId }, mocks.dependencies);

      expect(result).toMatchObject({
        outcome: 'not_processed',
        payment: {
          status: 'pending',
          lastSafeOutcome: 'not_processed',
        },
        order: {
          status: 'pending_payment',
          inventoryDisposition: 'held',
        },
      });
      expect(mocks.state.available).toBe(3);
      expect(mocks.ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mocks.sessions[0].startTransaction).not.toHaveBeenCalled();
    });

    test('records a processed response timeout as unknown, not as a definite failure', async () => {
      const providerError = Object.assign(new Error('Processed response was lost'), {
        code: 'PROCESSED_RESPONSE_TIMEOUT',
      });
      const mocks = createAttemptDependencies({ providerResult: providerError });

      const result = await attemptPayment({ runId, orderId }, mocks.dependencies);

      expect(result).toMatchObject({
        outcome: 'unknown',
        payment: {
          status: 'unknown',
          lastSafeOutcome: 'unknown',
        },
        order: {
          status: 'pending_payment',
          inventoryDisposition: 'held',
        },
      });
      expect(result.payment.status).not.toBe('declined');
      expect(result.order.status).not.toBe('payment_failed');
      expect(mocks.state.available).toBe(3);
      expect(mocks.ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mocks.sessions[0].startTransaction).not.toHaveBeenCalled();
    });

    test('propagates persistence errors after provider success without recording decline or releasing stock', async () => {
      const persistenceError = new Error('Order persistence unavailable');
      const mocks = createAttemptDependencies({ orderUpdateError: persistenceError });

      await expect(attemptPayment({ runId, orderId }, mocks.dependencies))
        .rejects.toBe(persistenceError);

      expect(mocks.paymentProvider.charge).toHaveBeenCalledTimes(1);
      expect(mocks.sessions[1].abortTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.state.payment).toMatchObject({
        status: 'processing',
        lastSafeOutcome: 'pending',
        providerOperationReference: null,
      });
      expect(mocks.state.payment.status).not.toBe('declined');
      expect(mocks.state.order).toMatchObject({
        status: 'pending_payment',
        inventoryDisposition: 'held',
      });
      expect(mocks.state.order.status).not.toBe('payment_failed');
      expect(mocks.state.available).toBe(3);
      expect(mocks.ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('does not reapply a definitive result or release inventory on a duplicate attempt', async () => {
      const mocks = createAttemptDependencies({
        providerResult: {
          runId,
          operationKey: 'op-stable-1',
          status: 'declined',
          providerReference: 'provider-decline-1',
        },
      });

      await attemptPayment({ runId, orderId }, mocks.dependencies);
      await expect(attemptPayment({ runId, orderId }, mocks.dependencies))
        .rejects.toBeInstanceOf(PaymentOrderNotPayableError);
      expect(mocks.paymentProvider.charge).toHaveBeenCalledTimes(1);
      expect(mocks.ProductModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mocks.state.available).toBe(5);
    });

    test('aborts all outcome writes if the inventory release cannot be persisted', async () => {
      const mocks = createAttemptDependencies({
        providerResult: {
          runId,
          operationKey: 'op-stable-1',
          status: 'declined',
          providerReference: 'provider-decline-1',
        },
        failInventoryRelease: true,
      });

      await expect(attemptPayment({ runId, orderId }, mocks.dependencies))
        .rejects.toThrow('Product for the held inventory reservation was not found');

      expect(mocks.sessions[1].abortTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.sessions[1].commitTransaction).not.toHaveBeenCalled();
      expect(mocks.state.payment.status).toBe('processing');
      expect(mocks.state.order).toMatchObject({
        status: 'pending_payment',
        inventoryDisposition: 'held',
      });
      expect(mocks.state.available).toBe(3);
    });

    test('aborts if a conditional order update rejects the provider result', async () => {
      const mocks = createAttemptDependencies({ failOrderUpdate: true });

      await expect(attemptPayment({ runId, orderId }, mocks.dependencies))
        .rejects.toBeInstanceOf(PaymentOutcomeConflictError);

      expect(mocks.sessions[1].abortTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.state.payment.status).toBe('processing');
      expect(mocks.state.available).toBe(3);
      expect(mocks.ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  test('rejects invalid identifiers before querying models', async () => {
    const models = createClaimHarness();

    await expect(preparePaymentAttempt({ runId: 'invalid run', orderId }, models))
      .rejects.toThrow('A valid runId is required');
    await expect(preparePaymentAttempt({ runId, orderId: '' }, models))
      .rejects.toThrow('A non-empty orderId is required');

    expect(models.OrderModel.findOne).not.toHaveBeenCalled();
    expect(models.PaymentModel.findOne).not.toHaveBeenCalled();
    expect(models.PaymentModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

import { jest } from '@jest/globals';
import {
  PaymentWebhookEventConflictError,
  PaymentWebhookPaymentNotFoundError,
  PaymentWebhookPayloadConflictError,
  processPaymentWebhook,
} from '../src/services/payment-webhooks.js';
import { validateAndHashPaymentWebhook } from '../src/utils/payment-webhook-payload.js';

const runId = 'run-webhook';
const paymentObjectId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orderObjectId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const productObjectId = 'cccccccccccccccccccccccc';
const paymentPublicId = `pay_${paymentObjectId}`;
const baseBody = {
  eventId: 'evt-1',
  type: 'payment.succeeded',
  paymentId: paymentPublicId,
  operationKey: 'op-stable-1',
  amountMinor: 2500,
  currency: 'USD',
};

function createWebhookHarness({
  payment: paymentOverrides = {},
  order: orderOverrides = {},
  product: productOverrides = {},
  duplicateEventOnInsert = false,
  hideEventInsideTransaction = false,
  raceCommitOutcomeAfterAbort = false,
  paymentUpdateConflict = false,
  productUpdateError,
} = {}) {
  const state = {
    payment: {
      _id: paymentObjectId,
      runId,
      orderId: orderObjectId,
      operationKey: 'op-stable-1',
      amountMinor: 2500,
      currency: 'USD',
      status: 'processing',
      lastSafeOutcome: 'pending',
      ...paymentOverrides,
    },
    order: {
      _id: orderObjectId,
      runId,
      paymentId: paymentObjectId,
      amountMinor: 2500,
      currency: 'USD',
      status: 'pending_payment',
      inventoryDisposition: 'held',
      version: 4,
      items: [{ productId: productObjectId, quantity: 2 }],
      ...orderOverrides,
    },
    product: {
      _id: productObjectId,
      runId,
      available: 3,
      ...productOverrides,
    },
    events: [],
  };
  const calls = { paymentUpdates: [], orderUpdates: [], productUpdates: [] };
  let transactionTail = Promise.resolve();

  function restore(snapshot) {
    for (const key of Object.keys(state)) {
      state[key] = structuredClone(snapshot[key]);
    }
  }

  async function runTransaction(session, callback) {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = structuredClone(state);
    try {
      const result = await callback(session);
      return result;
    } catch (error) {
      restore(snapshot);
      if (raceCommitOutcomeAfterAbort) {
        state.payment.status = 'succeeded';
        state.payment.lastSafeOutcome = 'succeeded';
        state.order.status = 'paid';
        state.order.inventoryDisposition = 'consumed';
        state.order.version += 1;
      }
      throw error;
    } finally {
      release();
    }
  }

  const sessions = [];
  const startSession = jest.fn(async () => {
    const session = {
      withTransaction: jest.fn((callback) => runTransaction(session, callback)),
      endSession: jest.fn(),
    };
    sessions.push(session);
    return session;
  });

  const ProcessedWebhookModel = {
    findOne: jest.fn(async (filter, _projection, options = {}) => {
      if (options.session && hideEventInsideTransaction) {
        return null;
      }
      return state.events.find((event) => (
        event.runId === filter.runId && event.eventId === filter.eventId
      )) ?? null;
    }),
    create: jest.fn(async ([record], { session } = {}) => {
      if (duplicateEventOnInsert && session) {
        const duplicateError = new Error('Duplicate webhook event key');
        duplicateError.code = 11000;
        duplicateError.keyPattern = { runId: 1, eventId: 1 };
        throw duplicateError;
      }
      if (state.events.some((event) => (
        event.runId === record.runId && event.eventId === record.eventId
      ))) {
        const duplicateError = new Error('Duplicate webhook event key');
        duplicateError.code = 11000;
        duplicateError.keyPattern = { runId: 1, eventId: 1 };
        throw duplicateError;
      }
      state.events.push(structuredClone(record));
      return [structuredClone(record)];
    }),
  };

  const PaymentModel = {
    findOne: jest.fn(async (filter) => (
      state.payment.runId === filter.runId
      && state.payment._id === String(filter._id)
        ? { ...state.payment }
        : null
    )),
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.paymentUpdates.push({ filter, update, options });
      if (paymentUpdateConflict) {
        return null;
      }
      if (Object.entries(filter).some(([key, value]) => (
        String(state.payment[key]) !== String(value)
      ))) {
        return null;
      }
      state.payment = {
        ...state.payment,
        ...update.$set,
      };
      return { ...state.payment };
    }),
  };

  const OrderModel = {
    findOne: jest.fn(async (filter) => (
      state.order.runId === filter.runId
      && state.order._id === String(filter._id)
        ? { ...state.order }
        : null
    )),
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.orderUpdates.push({ filter, update, options });
      if (Object.entries(filter).some(([key, value]) => (
        String(state.order[key]) !== String(value)
      ))) {
        return null;
      }
      state.order = {
        ...state.order,
        ...update.$set,
        version: state.order.version + update.$inc.version,
      };
      return { ...state.order };
    }),
  };

  const ProductModel = {
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.productUpdates.push({ filter, update, options });
      if (productUpdateError) {
        throw productUpdateError;
      }
      if (
        state.product.runId !== filter.runId
        || state.product._id !== String(filter._id)
      ) {
        return null;
      }
      state.product.available += update.$inc.available;
      return { ...state.product };
    }),
  };

  return {
    state,
    calls,
    sessions,
    startSession,
    OrderModel,
    PaymentModel,
    ProductModel,
    ProcessedWebhookModel,
    dependencies: {
      OrderModel,
      PaymentModel,
      ProductModel,
      ProcessedWebhookModel,
      startSession,
    },
  };
}

function applyWebhook(harness, body = baseBody, headerRunId = runId) {
  return processPaymentWebhook(
    { runIdHeader: headerRunId, body },
    harness.dependencies,
  );
}

describe('Payment webhook service', () => {
  test('applies success atomically and consumes the held inventory without changing stock', async () => {
    const harness = createWebhookHarness({ payment: { status: 'pending' } });

    await expect(applyWebhook(harness)).resolves.toEqual({
      eventId: 'evt-1',
      processingResult: 'applied',
      duplicate: false,
    });

    expect(harness.state.payment).toMatchObject({
      status: 'succeeded',
      lastSafeOutcome: 'succeeded',
      capturedAt: expect.any(Date),
    });
    expect(harness.state.order).toMatchObject({
      status: 'paid',
      inventoryDisposition: 'consumed',
      version: 5,
    });
    expect(harness.state.product.available).toBe(3);
    expect(harness.calls.productUpdates).toHaveLength(0);
    expect(harness.calls.paymentUpdates[0].filter).toMatchObject({
      runId,
      status: 'pending',
      operationKey: 'op-stable-1',
    });
    expect(harness.calls.orderUpdates[0].filter).toMatchObject({
      runId,
      status: 'pending_payment',
      inventoryDisposition: 'held',
      version: 4,
    });
    expect(harness.calls.paymentUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(harness.calls.orderUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(
      harness.ProcessedWebhookModel.create.mock.calls[0][1].session,
    ).toBe(harness.sessions[0]);
    expect(harness.state.events).toMatchObject([{
      runId,
      eventId: 'evt-1',
      paymentId: paymentPublicId,
      operationKey: 'op-stable-1',
      type: 'payment.succeeded',
      processingResult: 'applied',
    }]);
  });

  test('applies decline and releases held inventory exactly once', async () => {
    const harness = createWebhookHarness();
    const body = { ...baseBody, type: 'payment.declined' };

    await expect(applyWebhook(harness, body)).resolves.toMatchObject({
      processingResult: 'applied',
      duplicate: false,
    });

    expect(harness.state.payment).toMatchObject({
      status: 'declined',
      lastSafeOutcome: 'declined',
    });
    expect(harness.state.order).toMatchObject({
      status: 'payment_failed',
      inventoryDisposition: 'released',
      version: 5,
    });
    expect(harness.state.product.available).toBe(5);
    expect(harness.calls.productUpdates).toHaveLength(1);
    expect(harness.calls.productUpdates[0]).toMatchObject({
      filter: { runId, _id: productObjectId },
      update: { $inc: { available: 2 } },
      options: { session: harness.sessions[0] },
    });
    expect(harness.calls.paymentUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(harness.calls.orderUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(
      harness.ProcessedWebhookModel.create.mock.calls[0][1].session,
    ).toBe(harness.sessions[0]);
  });

  test.each([
    ['success', 'payment.succeeded'],
    ['decline', 'payment.declined'],
  ])('accepts a matching %s webhook for an unknown Payment', async (_label, type) => {
    const harness = createWebhookHarness({ payment: { status: 'unknown' } });

    await expect(applyWebhook(harness, { ...baseBody, type }))
      .resolves.toMatchObject({
        eventId: 'evt-1',
        processingResult: 'applied',
        duplicate: false,
      });

    expect(harness.state.payment.status).toBe(
      type === 'payment.succeeded' ? 'succeeded' : 'declined',
    );
    expect(harness.state.events).toHaveLength(1);
  });

  test('returns an exact replay without repeating payment, order, or inventory effects', async () => {
    const harness = createWebhookHarness();

    await applyWebhook(harness);
    await expect(applyWebhook(harness)).resolves.toEqual({
      eventId: 'evt-1',
      processingResult: 'applied',
      duplicate: true,
    });

    expect(harness.state.events).toHaveLength(1);
    expect(harness.calls.paymentUpdates).toHaveLength(1);
    expect(harness.calls.orderUpdates).toHaveLength(1);
    expect(harness.state.product.available).toBe(3);
  });

  test('records a new event for an already-applied matching outcome without repeating effects', async () => {
    const harness = createWebhookHarness({
      payment: { status: 'succeeded', lastSafeOutcome: 'succeeded' },
      order: {
        status: 'paid',
        inventoryDisposition: 'consumed',
        version: 7,
      },
    });

    await expect(applyWebhook(harness, { ...baseBody, eventId: 'evt-2' }))
      .resolves.toEqual({
        eventId: 'evt-2',
        processingResult: 'applied',
        duplicate: false,
      });

    expect(harness.calls.paymentUpdates).toHaveLength(0);
    expect(harness.calls.orderUpdates).toHaveLength(0);
    expect(harness.calls.productUpdates).toHaveLength(0);
    expect(harness.state.order.version).toBe(7);
    expect(harness.state.events).toHaveLength(1);
  });

  test('acknowledges a matching decline outcome without releasing inventory again', async () => {
    const harness = createWebhookHarness({
      payment: { status: 'declined', lastSafeOutcome: 'declined' },
      order: {
        status: 'payment_failed',
        inventoryDisposition: 'released',
        version: 8,
      },
      product: { available: 5 },
    });

    await expect(applyWebhook(harness, {
      ...baseBody,
      eventId: 'evt-decline-replay',
      type: 'payment.declined',
    })).resolves.toEqual({
      eventId: 'evt-decline-replay',
      processingResult: 'applied',
      duplicate: false,
    });

    expect(harness.state.product.available).toBe(5);
    expect(harness.calls.productUpdates).toHaveLength(0);
    expect(harness.calls.paymentUpdates).toHaveLength(0);
    expect(harness.calls.orderUpdates).toHaveLength(0);
  });

  test('rejects reuse of an event ID with a different payload', async () => {
    const harness = createWebhookHarness();
    await applyWebhook(harness);

    await expect(applyWebhook(harness, { ...baseBody, amountMinor: 2501 }))
      .rejects.toBeInstanceOf(PaymentWebhookPayloadConflictError);

    expect(harness.state.events).toHaveLength(1);
    expect(harness.state.payment.status).toBe('succeeded');
    expect(harness.state.order.version).toBe(5);
    expect(harness.calls.paymentUpdates).toHaveLength(1);
  });

  test('does not resolve a payment from another run', async () => {
    const harness = createWebhookHarness();

    await expect(applyWebhook(harness, baseBody, 'run-other'))
      .rejects.toBeInstanceOf(PaymentWebhookPaymentNotFoundError);

    expect(harness.state.events).toHaveLength(0);
    expect(harness.calls.paymentUpdates).toHaveLength(0);
  });

  test.each([
    ['decline while pending', { status: 'pending' }, {}, 'payment.declined'],
    ['success against a terminal decline', { status: 'declined' }, {
      status: 'payment_failed',
      inventoryDisposition: 'released',
    }, 'payment.succeeded'],
    ['success when Order is no longer payable', { status: 'processing' }, {
      status: 'cancelled',
      inventoryDisposition: 'released',
    }, 'payment.succeeded'],
    ['success with a mismatched inventory disposition', { status: 'processing' }, {
      inventoryDisposition: 'consumed',
    }, 'payment.succeeded'],
  ])('rejects %s without persisting an event', async (
    _description,
    payment,
    order,
    type,
  ) => {
    const harness = createWebhookHarness({ payment, order });

    await expect(applyWebhook(harness, { ...baseBody, type }))
      .rejects.toBeInstanceOf(PaymentWebhookEventConflictError);

    expect(harness.state.events).toHaveLength(0);
    expect(harness.calls.paymentUpdates).toHaveLength(0);
    expect(harness.calls.orderUpdates).toHaveLength(0);
    expect(harness.state.product.available).toBe(3);
  });

  test('rejects charge detail and payment/order linkage mismatches', async () => {
    const badCharge = createWebhookHarness({
      payment: { status: 'processing', operationKey: 'other-operation' },
    });
    const brokenLink = createWebhookHarness({
      order: { paymentId: 'dddddddddddddddddddddddd' },
    });

    await expect(applyWebhook(badCharge))
      .rejects.toBeInstanceOf(PaymentWebhookEventConflictError);
    await expect(applyWebhook(brokenLink))
      .rejects.toBeInstanceOf(PaymentWebhookEventConflictError);
    expect(badCharge.state.events).toHaveLength(0);
    expect(brokenLink.state.events).toHaveLength(0);
  });

  test('concurrent duplicate deliveries apply effects once and return one replay', async () => {
    const harness = createWebhookHarness({
      payment: { status: 'processing' },
    });

    const results = await Promise.all([
      applyWebhook(harness, { ...baseBody, type: 'payment.declined' }),
      applyWebhook(harness, { ...baseBody, type: 'payment.declined' }),
    ]);

    expect(results.map(({ duplicate }) => duplicate).sort()).toEqual([false, true]);
    expect(harness.state.events).toHaveLength(1);
    expect(harness.state.product.available).toBe(5);
    expect(harness.calls.paymentUpdates).toHaveLength(1);
    expect(harness.calls.orderUpdates).toHaveLength(1);
    expect(harness.calls.productUpdates).toHaveLength(1);
  });

  test('reconciles a concurrent matching payment outcome without repeating effects', async () => {
    const harness = createWebhookHarness({
      payment: { status: 'processing' },
      raceCommitOutcomeAfterAbort: true,
      paymentUpdateConflict: true,
    });

    await expect(applyWebhook(harness)).resolves.toEqual({
      eventId: 'evt-1',
      processingResult: 'applied',
      duplicate: false,
    });

    expect(harness.state.payment.status).toBe('succeeded');
    expect(harness.state.order).toMatchObject({
      status: 'paid',
      inventoryDisposition: 'consumed',
      version: 5,
    });
    expect(harness.state.events).toHaveLength(1);
    expect(harness.calls.productUpdates).toHaveLength(0);
  });

  test('aborts event, state, and inventory writes when decline inventory persistence fails', async () => {
    const persistenceError = new Error('Product update failed');
    const harness = createWebhookHarness({
      productUpdateError: persistenceError,
    });

    await expect(applyWebhook(harness, {
      ...baseBody,
      type: 'payment.declined',
    })).rejects.toBe(persistenceError);

    expect(harness.state.events).toHaveLength(0);
    expect(harness.state.payment.status).toBe('processing');
    expect(harness.state.order).toMatchObject({
      status: 'pending_payment',
      inventoryDisposition: 'held',
      version: 4,
    });
    expect(harness.state.product.available).toBe(3);
  });

  test('rereads the event after a duplicate-key transaction abort', async () => {
    const harness = createWebhookHarness({
      duplicateEventOnInsert: true,
      hideEventInsideTransaction: true,
    });
    const { canonicalEvent, payloadHash } = validateAndHashPaymentWebhook({
      runIdHeader: runId,
      body: baseBody,
    });
    harness.state.events.push({
      runId: canonicalEvent.runId,
      eventId: canonicalEvent.eventId,
      payloadHash,
      paymentId: canonicalEvent.paymentId,
      operationKey: canonicalEvent.operationKey,
      type: canonicalEvent.type,
      processingResult: 'applied',
      processedAt: new Date(),
    });

    await expect(applyWebhook(harness)).resolves.toEqual({
      eventId: 'evt-1',
      processingResult: 'applied',
      duplicate: true,
    });
    expect(harness.calls.paymentUpdates).toHaveLength(0);
    expect(harness.state.order.version).toBe(4);
  });
});

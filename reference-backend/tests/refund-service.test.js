import { jest } from '@jest/globals';
import {
  RefundIntentConflictError,
  RefundPaymentNotFoundError,
  processRefund,
} from '../src/services/refunds.js';
import { createMockPaymentProvider } from '../src/provider/mock-payment-provider.js';

const runId = 'run-refund';
const paymentId = 'payment-1';
const orderId = 'order-1';
const eventId = 'event-1';

function createRefundHarness({
  payment: paymentOverrides = {},
  order: orderOverrides = {},
  event: eventOverrides = {},
  failOrderUpdate = false,
} = {}) {
  const state = {
    payment: {
      _id: paymentId,
      runId,
      orderId,
      operationKey: 'op-stable-1',
      refundOperationKey: 'refund-stable-1',
      status: 'refund_pending',
      amountMinor: 2500,
      currency: 'USD',
      ...paymentOverrides,
    },
    order: {
      _id: orderId,
      runId,
      paymentId,
      status: 'cancellation_pending_refund',
      inventoryDisposition: 'released',
      version: 4,
      ...orderOverrides,
    },
    event: {
      _id: 'webhook-1',
      runId,
      eventId,
      paymentId: `pay_${paymentId}`,
      operationKey: 'op-stable-1',
      type: 'payment.succeeded',
      processingResult: 'refund_pending',
      ...eventOverrides,
    },
  };
  const calls = { paymentUpdates: [], orderUpdates: [], eventUpdates: [] };
  const sessions = [];
  let transactionActive = false;

  function snapshot() {
    return structuredClone(state);
  }

  function restore(previous) {
    state.payment = previous.payment;
    state.order = previous.order;
    state.event = previous.event;
  }

  const startSession = jest.fn(async () => {
    const session = {
      withTransaction: jest.fn(async (callback) => {
        const previous = snapshot();
        transactionActive = true;
        try {
          return await callback(session);
        } catch (error) {
          restore(previous);
          throw error;
        } finally {
          transactionActive = false;
        }
      }),
      endSession: jest.fn(),
    };
    sessions.push(session);
    return session;
  });

  function matches(record, filter) {
    return Object.entries(filter).every(([key, value]) => record[key] === value);
  }

  const PaymentModel = {
    findOne: jest.fn(async (filter, _projection, options) => {
      if (options?.session) {
        expect(options.session).toBe(sessions.at(-1));
      }
      return matches(state.payment, filter) ? { ...state.payment } : null;
    }),
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.paymentUpdates.push({ filter, update, options });
      if (!matches(state.payment, filter)) {
        return null;
      }
      state.payment = { ...state.payment, ...update.$set };
      return { ...state.payment };
    }),
  };

  const OrderModel = {
    findOne: jest.fn(async (filter, _projection, options) => {
      if (options?.session) {
        expect(options.session).toBe(sessions.at(-1));
      }
      return matches(state.order, filter) ? { ...state.order } : null;
    }),
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.orderUpdates.push({ filter, update, options });
      if (failOrderUpdate || !matches(state.order, filter)) {
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

  const ProcessedWebhookModel = {
    findOne: jest.fn(async (filter, _projection, options) => {
      if (options?.session) {
        expect(options.session).toBe(sessions.at(-1));
      }
      return matches(state.event, filter) ? { ...state.event } : null;
    }),
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.eventUpdates.push({ filter, update, options });
      if (!matches(state.event, filter)) {
        return null;
      }
      state.event = { ...state.event, ...update.$set };
      return { ...state.event };
    }),
  };

  return {
    state,
    calls,
    sessions,
    startSession,
    isTransactionActive: () => transactionActive,
    dependencies: { PaymentModel, OrderModel, ProcessedWebhookModel, startSession },
  };
}

function providerResult(overrides = {}) {
  return {
    runId,
    refundOperationKey: 'refund-stable-1',
    originalOperationKey: 'op-stable-1',
    status: 'refunded',
    amountMinor: 2500,
    currency: 'USD',
    providerReference: 'provider-refund-1',
    ...overrides,
  };
}

function refund(harness, options = {}, refundProvider = jest.fn(async () => providerResult())) {
  return processRefund(
    { runId, paymentId, ...options },
    { ...harness.dependencies, refundProvider },
  );
}

describe('processRefund', () => {
  test('calls the provider outside the transaction and completes all persisted state atomically', async () => {
    const harness = createRefundHarness();
    const refundProvider = jest.fn(async () => {
      expect(harness.isTransactionActive()).toBe(false);
      return providerResult();
    });

    const result = await refund(harness, { eventId }, refundProvider);

    expect(refundProvider).toHaveBeenCalledWith(
      runId,
      'refund-stable-1',
      'op-stable-1',
    );
    expect(result).toMatchObject({
      payment: {
        status: 'refunded',
        lastSafeOutcome: 'refunded',
        refundOperationReference: 'provider-refund-1',
      },
      order: {
        status: 'cancelled',
        inventoryDisposition: 'released',
        version: 5,
      },
      event: { processingResult: 'refund_completed' },
      replayed: false,
    });
    expect(harness.calls.paymentUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(harness.calls.orderUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(harness.calls.eventUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(harness.calls.orderUpdates[0].filter).toMatchObject({
      runId,
      status: 'cancellation_pending_refund',
      inventoryDisposition: 'released',
      version: 4,
    });
    expect(harness.calls.orderUpdates[0].update.$set).not.toHaveProperty(
      'inventoryDisposition',
    );
  });

  test('retries with the same stable key after provider success and database failure', async () => {
    const harness = createRefundHarness({ failOrderUpdate: true });
    const refundProvider = jest.fn(async () => providerResult());

    await expect(refund(harness, { eventId }, refundProvider))
      .rejects.toBeInstanceOf(RefundIntentConflictError);

    expect(harness.state.payment.status).toBe('refund_pending');
    expect(harness.state.order.status).toBe('cancellation_pending_refund');
    expect(harness.state.event.processingResult).toBe('refund_pending');

    harness.dependencies.OrderModel.findOneAndUpdate.mockImplementationOnce(
      async (filter, update, options) => {
        harness.calls.orderUpdates.push({ filter, update, options });
        if (!Object.entries(filter).every(([key, value]) => (
          harness.state.order[key] === value
        ))) {
          return null;
        }
        harness.state.order = {
          ...harness.state.order,
          ...update.$set,
          version: harness.state.order.version + update.$inc.version,
        };
        return { ...harness.state.order };
      },
    );

    const retried = await refund(harness, { eventId }, refundProvider);

    expect(refundProvider).toHaveBeenNthCalledWith(
      1,
      runId,
      'refund-stable-1',
      'op-stable-1',
    );
    expect(refundProvider).toHaveBeenNthCalledWith(
      2,
      runId,
      'refund-stable-1',
      'op-stable-1',
    );
    expect(retried.payment.status).toBe('refunded');
    expect(retried.order.status).toBe('cancelled');
    expect(retried.event.processingResult).toBe('refund_completed');
  });

  test('uses the mock provider ledger to make a retry idempotent', async () => {
    const harness = createRefundHarness({ failOrderUpdate: true });
    const provider = createMockPaymentProvider();
    await provider.charge(runId, 'op-stable-1', 2500, 'USD');

    await expect(refund(harness, { eventId }, provider.refund))
      .rejects.toBeInstanceOf(RefundIntentConflictError);
    expect(provider.inspectLedger(runId).refunds).toHaveLength(1);

    harness.dependencies.OrderModel.findOneAndUpdate.mockImplementationOnce(
      async (filter, update, options) => {
        harness.calls.orderUpdates.push({ filter, update, options });
        if (!Object.entries(filter).every(([key, value]) => (
          harness.state.order[key] === value
        ))) {
          return null;
        }
        harness.state.order = {
          ...harness.state.order,
          ...update.$set,
          version: harness.state.order.version + update.$inc.version,
        };
        return { ...harness.state.order };
      },
    );

    const retried = await refund(harness, { eventId }, provider.refund);
    const ledger = provider.inspectLedger(runId);

    expect(retried.payment.status).toBe('refunded');
    expect(retried.order.status).toBe('cancelled');
    expect(retried.event.processingResult).toBe('refund_completed');
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds[0]).toMatchObject({
      refundOperationKey: 'refund-stable-1',
      originalOperationKey: 'op-stable-1',
    });
  });

  test('rejects a declined webhook event without changing persisted state', async () => {
    const harness = createRefundHarness({
      event: { type: 'payment.declined' },
    });
    const before = structuredClone(harness.state);
    const refundProvider = jest.fn();

    await expect(refund(harness, { eventId }, refundProvider))
      .rejects.toBeInstanceOf(RefundIntentConflictError);

    expect(harness.state).toEqual(before);
    expect(refundProvider).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  test.each([
    ['another run', { runId: 'other-run' }],
    ['another Payment', { paymentId: 'pay_another-payment' }],
  ])('rejects a webhook event linked to %s', async (_label, eventOverrides) => {
    const harness = createRefundHarness({ event: eventOverrides });
    const refundProvider = jest.fn();

    await expect(refund(harness, { eventId }, refundProvider))
      .rejects.toBeInstanceOf(RefundIntentConflictError);

    expect(harness.state.payment.status).toBe('refund_pending');
    expect(harness.state.order.status).toBe('cancellation_pending_refund');
    expect(harness.state.event.processingResult).toBe('refund_pending');
    expect(refundProvider).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  test('completes a cancellation-triggered refund without a webhook event', async () => {
    const harness = createRefundHarness();

    const result = await refund(harness);

    expect(result).toMatchObject({
      payment: { status: 'refunded' },
      order: { status: 'cancelled', version: 5 },
      replayed: false,
    });
    expect(result).not.toHaveProperty('event');
    expect(harness.dependencies.ProcessedWebhookModel.findOne)
      .not.toHaveBeenCalled();
    expect(harness.dependencies.ProcessedWebhookModel.findOneAndUpdate)
      .not.toHaveBeenCalled();
  });

  test('rejects a missing refund intent without calling the provider', async () => {
    const harness = createRefundHarness({
      payment: { status: 'succeeded' },
    });
    const refundProvider = jest.fn();

    await expect(refund(harness, {}, refundProvider))
      .rejects.toBeInstanceOf(RefundIntentConflictError);

    expect(refundProvider).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  test('does not access another run payment or mutate its state', async () => {
    const harness = createRefundHarness({
      payment: { runId: 'other-run' },
      order: { runId: 'other-run' },
    });
    const paymentBefore = { ...harness.state.payment };
    const refundProvider = jest.fn();

    await expect(refund(harness, {}, refundProvider))
      .rejects.toBeInstanceOf(RefundPaymentNotFoundError);

    expect(harness.state.payment).toEqual(paymentBefore);
    expect(harness.state.order.status).toBe('cancellation_pending_refund');
    expect(refundProvider).not.toHaveBeenCalled();
    expect(harness.calls.paymentUpdates).toHaveLength(0);
    expect(harness.calls.orderUpdates).toHaveLength(0);
  });

  test('rolls back Payment and Order updates when webhook completion fails', async () => {
    const harness = createRefundHarness();
    harness.dependencies.ProcessedWebhookModel.findOneAndUpdate
      .mockResolvedValueOnce(null);

    await expect(refund(harness, { eventId }))
      .rejects.toBeInstanceOf(RefundIntentConflictError);

    expect(harness.state.payment.status).toBe('refund_pending');
    expect(harness.state.order).toMatchObject({
      status: 'cancellation_pending_refund',
      inventoryDisposition: 'released',
      version: 4,
    });
    expect(harness.state.event.processingResult).toBe('refund_pending');
  });

  test('does not call the provider again after completion is already persisted', async () => {
    const harness = createRefundHarness({
      payment: {
        status: 'refunded',
        refundOperationReference: 'provider-refund-1',
      },
      order: { status: 'cancelled' },
      event: { processingResult: 'refund_completed' },
    });
    const refundProvider = jest.fn();

    const result = await refund(harness, { eventId }, refundProvider);

    expect(result.replayed).toBe(true);
    expect(refundProvider).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
  });
});

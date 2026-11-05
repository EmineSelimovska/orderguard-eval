import { jest } from '@jest/globals';
import {
  CancellationOrderNotFoundError,
  OrderAlreadyPaidError,
  OrderCancellationConflictError,
  PaymentOutcomeUnknownError,
  cancelOrder,
} from '../src/services/cancellations.js';

const runId = 'run-cancel';
const orderId = 'order-1';
const paymentId = 'payment-1';
const productId = 'product-1';

function createCancellationHarness({
  order: orderOverrides = {},
  payment: paymentOverrides = {},
  product: productOverrides = {},
  failProductUpdate = false,
  failPaymentUpdate = false,
} = {}) {
  const state = {
    order: {
      _id: orderId,
      runId,
      paymentId,
      status: 'pending_payment',
      inventoryDisposition: 'held',
      version: 2,
      items: [{ productId, quantity: 2 }],
      ...orderOverrides,
    },
    payment: {
      _id: paymentId,
      runId,
      orderId,
      status: 'pending',
      lastSafeOutcome: 'pending',
      operationKey: 'op-stable-1',
      refundOperationKey: undefined,
      ...paymentOverrides,
    },
    product: {
      _id: productId,
      runId,
      available: 3,
      ...productOverrides,
    },
  };
  const calls = { orderUpdates: [], paymentUpdates: [], productUpdates: [] };
  const sessions = [];

  function snapshot() {
    return structuredClone(state);
  }

  function restore(previous) {
    state.order = previous.order;
    state.payment = previous.payment;
    state.product = previous.product;
  }

  const startSession = jest.fn(async () => {
    let activeSnapshot;
    const session = {
      withTransaction: jest.fn(async (callback) => {
        activeSnapshot = snapshot();
        try {
          return await callback(session);
        } catch (error) {
          restore(activeSnapshot);
          throw error;
        }
      }),
      endSession: jest.fn(),
    };
    sessions.push(session);
    return session;
  });

  const OrderModel = {
    findOne: jest.fn(async (filter, _projection, options) => {
      expect(options.session).toBe(sessions.at(-1));
      return state.order.runId === filter.runId
        && state.order._id === filter._id
        ? { ...state.order }
        : null;
    }),
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.orderUpdates.push({ filter, update, options });
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
      return { ...state.order };
    }),
  };

  const PaymentModel = {
    findOne: jest.fn(async (filter, _projection, options) => {
      expect(options.session).toBe(sessions.at(-1));
      return state.payment.runId === filter.runId
        && state.payment._id === filter._id
        && state.payment.orderId === filter.orderId
        ? { ...state.payment }
        : null;
    }),
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.paymentUpdates.push({ filter, update, options });
      if (failPaymentUpdate || Object.entries(filter).some(([key, value]) => (
        state.payment[key] !== value
      ))) {
        return null;
      }
      state.payment = { ...state.payment, ...update.$set };
      return { ...state.payment };
    }),
  };

  const ProductModel = {
    findOneAndUpdate: jest.fn(async (filter, update, options) => {
      calls.productUpdates.push({ filter, update, options });
      if (
        failProductUpdate
        || state.product.runId !== filter.runId
        || state.product._id !== filter._id
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
    OrderModel,
    PaymentModel,
    ProductModel,
    dependencies: { OrderModel, PaymentModel, ProductModel, startSession },
  };
}

function cancel(harness, requestedRunId = runId, requestedOrderId = orderId) {
  return cancelOrder(
    { runId: requestedRunId, orderId: requestedOrderId },
    harness.dependencies,
  );
}

describe('cancelOrder', () => {
  test('cancels a pending order, voids payment, and releases held inventory atomically', async () => {
    const harness = createCancellationHarness();

    const result = await cancel(harness);

    expect(result).toMatchObject({
      order: {
        status: 'cancelled',
        inventoryDisposition: 'released',
        version: 3,
      },
      payment: {
        status: 'voided',
        lastSafeOutcome: 'voided',
      },
      replayed: false,
    });
    expect(harness.state.product.available).toBe(5);
    expect(harness.calls.orderUpdates[0].filter.version).toBe(2);
    expect(harness.calls.productUpdates[0]).toMatchObject({
      filter: { runId, _id: productId },
      update: { $inc: { available: 2 } },
      options: { session: harness.sessions[0] },
    });
    expect(harness.calls.orderUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(harness.calls.paymentUpdates[0].options.session).toBe(harness.sessions[0]);
  });

  test('returns an idempotent replay without releasing inventory again', async () => {
    const harness = createCancellationHarness({
      order: {
        status: 'cancelled',
        inventoryDisposition: 'released',
        version: 3,
      },
      payment: { status: 'voided', lastSafeOutcome: 'voided' },
      product: { available: 5 },
    });

    const result = await cancel(harness);

    expect(result.replayed).toBe(true);
    expect(harness.state.product.available).toBe(5);
    expect(harness.calls.orderUpdates).toHaveLength(0);
    expect(harness.calls.paymentUpdates).toHaveLength(0);
    expect(harness.calls.productUpdates).toHaveLength(0);
  });

  test('persists refund intent and releases inventory when cancellation discovers a capture', async () => {
    const harness = createCancellationHarness({
      payment: {
        status: 'succeeded',
        lastSafeOutcome: 'succeeded',
        providerOperationReference: 'provider-charge-1',
      },
    });

    const result = await cancel(harness);

    expect(result).toMatchObject({
      order: {
        status: 'cancellation_pending_refund',
        inventoryDisposition: 'released',
        version: 3,
      },
      payment: {
        status: 'refund_pending',
        refundOperationKey: 'refund_op-stable-1',
      },
      replayed: false,
      httpStatus: 202,
    });
    expect(harness.state.product.available).toBe(5);
    expect(harness.calls.orderUpdates[0].filter).toMatchObject({
      runId,
      status: 'pending_payment',
      inventoryDisposition: 'held',
      version: 2,
    });
    expect(harness.calls.paymentUpdates[0].filter).toMatchObject({
      runId,
      status: 'succeeded',
    });
    expect(harness.calls.orderUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(harness.calls.paymentUpdates[0].options.session).toBe(harness.sessions[0]);
    expect(harness.calls.productUpdates[0].options.session).toBe(harness.sessions[0]);
  });

  test('reuses an existing stable refund key when recording known-capture intent', async () => {
    const harness = createCancellationHarness({
      payment: {
        status: 'succeeded',
        refundOperationKey: 'persisted-refund-key',
      },
    });

    const result = await cancel(harness);

    expect(result.payment.refundOperationKey).toBe('persisted-refund-key');
    expect(result.httpStatus).toBe(202);
  });

  test('replays pending refund intent without releasing inventory again', async () => {
    const harness = createCancellationHarness({
      order: {
        status: 'cancellation_pending_refund',
        inventoryDisposition: 'released',
        version: 3,
      },
      payment: {
        status: 'refund_pending',
        refundOperationKey: 'refund_op-stable-1',
      },
      product: { available: 5 },
    });

    const result = await cancel(harness);

    expect(result).toMatchObject({
      order: { status: 'cancellation_pending_refund', version: 3 },
      payment: { status: 'refund_pending', refundOperationKey: 'refund_op-stable-1' },
      replayed: true,
      httpStatus: 202,
    });
    expect(harness.state.product.available).toBe(5);
    expect(harness.calls.orderUpdates).toHaveLength(0);
    expect(harness.calls.paymentUpdates).toHaveLength(0);
    expect(harness.calls.productUpdates).toHaveLength(0);
  });

  test('returns 404 behavior when the order is absent from the requested run', async () => {
    const harness = createCancellationHarness();

    await expect(cancel(harness, 'other-run'))
      .rejects.toBeInstanceOf(CancellationOrderNotFoundError);

    expect(harness.PaymentModel.findOne).not.toHaveBeenCalled();
    expect(harness.calls.productUpdates).toHaveLength(0);
  });

  test.each([
    ['paid order', {
      order: { status: 'paid', inventoryDisposition: 'consumed' },
      payment: { status: 'succeeded' },
    }, OrderAlreadyPaidError],
    ['processing payment', {
      payment: { status: 'processing' },
    }, PaymentOutcomeUnknownError],
    ['unknown payment', {
      payment: { status: 'unknown' },
    }, PaymentOutcomeUnknownError],
  ])('rejects %s without inventory changes', async (_label, overrides, ErrorType) => {
    const harness = createCancellationHarness(overrides);

    await expect(cancel(harness)).rejects.toBeInstanceOf(ErrorType);

    expect(harness.state.product.available).toBe(3);
    expect(harness.calls.productUpdates).toHaveLength(0);
  });

  test('rejects a stale Order version without applying Payment or inventory updates', async () => {
    const harness = createCancellationHarness();
    harness.state.order.version = 9;
    harness.OrderModel.findOneAndUpdate.mockResolvedValueOnce(null);

    await expect(cancel(harness))
      .rejects.toBeInstanceOf(OrderCancellationConflictError);

    expect(harness.state.product.available).toBe(3);
    expect(harness.calls.paymentUpdates).toHaveLength(0);
    expect(harness.calls.productUpdates).toHaveLength(0);
  });

  test('rolls back all writes when Payment conditional update fails', async () => {
    const harness = createCancellationHarness({ failPaymentUpdate: true });

    await expect(cancel(harness))
      .rejects.toBeInstanceOf(OrderCancellationConflictError);

    expect(harness.state.order).toMatchObject({
      status: 'pending_payment',
      inventoryDisposition: 'held',
      version: 2,
    });
    expect(harness.state.payment.status).toBe('pending');
    expect(harness.state.product.available).toBe(3);
    expect(harness.calls.productUpdates).toHaveLength(0);
  });

  test('rolls back Order and Payment writes when Product release fails', async () => {
    const harness = createCancellationHarness({ failProductUpdate: true });

    await expect(cancel(harness)).rejects.toThrow(
      'Product for the held inventory reservation was not found',
    );

    expect(harness.state.order).toMatchObject({
      status: 'pending_payment',
      inventoryDisposition: 'held',
      version: 2,
    });
    expect(harness.state.payment.status).toBe('pending');
    expect(harness.state.product.available).toBe(3);
  });

  test('rolls back known-capture intent writes when inventory release fails', async () => {
    const harness = createCancellationHarness({
      payment: { status: 'succeeded' },
      failProductUpdate: true,
    });

    await expect(cancel(harness)).rejects.toThrow(
      'Product for the held inventory reservation was not found',
    );

    expect(harness.state.order).toMatchObject({
      status: 'pending_payment',
      inventoryDisposition: 'held',
      version: 2,
    });
    expect(harness.state.payment).toMatchObject({
      status: 'succeeded',
      refundOperationKey: undefined,
    });
    expect(harness.state.product.available).toBe(3);
  });
});

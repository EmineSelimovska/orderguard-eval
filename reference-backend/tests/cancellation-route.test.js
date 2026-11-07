import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app.js';

const RUN_ID = 'run-cancel';
const ORDER_OBJECT_ID = '64b000000000000000000001';
const PAYMENT_OBJECT_ID = '64b000000000000000000002';
const ORDER_ID = `ord_${ORDER_OBJECT_ID}`;

function createCancellationResult({
  runId = RUN_ID,
  orderStatus = 'cancelled',
  paymentStatus = 'voided',
  inventoryDisposition = 'released',
  replayed = false,
  httpStatus,
} = {}) {
  return {
    order: {
      _id: ORDER_OBJECT_ID,
      runId,
      status: orderStatus,
      items: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1250 }],
      amountMinor: 2500,
      currency: 'USD',
      inventoryDisposition,
    },
    payment: {
      _id: PAYMENT_OBJECT_ID,
      status: paymentStatus,
      operationKey: 'op-stable-1',
    },
    replayed,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function createTestApp(serviceImplementation = jest.fn(async () => (
  createCancellationResult()
))) {
  const cancelOrderService = jest.fn(serviceImplementation);
  return {
    app: createApp({ cancelOrderService }),
    cancelOrderService,
  };
}

function postCancellation(app, {
  runId = RUN_ID,
  orderId = ORDER_ID,
  body,
} = {}) {
  let testRequest = request(app).post(`/api/orders/${orderId}/cancel`);

  if (runId !== null) {
    testRequest = testRequest.set('X-Benchmark-Run-Id', runId);
  }
  if (body !== undefined) {
    testRequest = testRequest.send(body);
  }
  return testRequest;
}

describe('POST /api/orders/:orderId/cancel', () => {
  test('returns the completed cancellation representation', async () => {
    const { app, cancelOrderService } = createTestApp();

    const response = await postCancellation(app, {
      body: { reason: 'customer_request' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      order: {
        id: ORDER_ID,
        runId: RUN_ID,
        status: 'cancelled',
        items: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1250 }],
        amountMinor: 2500,
        currency: 'USD',
        payment: {
          id: `pay_${PAYMENT_OBJECT_ID}`,
          status: 'voided',
          operationKey: 'op-stable-1',
        },
        inventoryDisposition: 'released',
      },
      replayed: false,
    });
    expect(cancelOrderService).toHaveBeenCalledWith({
      runId: RUN_ID,
      orderId: ORDER_OBJECT_ID,
    });
  });

  test('cancels successfully with an empty request body', async () => {
    const { app, cancelOrderService } = createTestApp();

    const response = await postCancellation(app);

    expect(response.status).toBe(200);
    expect(response.body.order.status).toBe('cancelled');
    expect(response.body.order.payment.status).toBe('voided');
    expect(response.body.replayed).toBe(false);
    expect(cancelOrderService).toHaveBeenCalledWith({
      runId: RUN_ID,
      orderId: ORDER_OBJECT_ID,
    });
  });

  test('returns 202 with the pending-refund state', async () => {
    const { app } = createTestApp(async () => createCancellationResult({
      orderStatus: 'cancellation_pending_refund',
      paymentStatus: 'refund_pending',
      replayed: false,
      httpStatus: 202,
    }));

    const response = await postCancellation(app);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      order: {
        id: ORDER_ID,
        runId: RUN_ID,
        status: 'cancellation_pending_refund',
        items: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1250 }],
        amountMinor: 2500,
        currency: 'USD',
        payment: {
          id: `pay_${PAYMENT_OBJECT_ID}`,
          status: 'refund_pending',
          operationKey: 'op-stable-1',
        },
        inventoryDisposition: 'released',
      },
      replayed: false,
    });
  });

  test('returns HTTP 200 with replayed true for completed cancellation replay', async () => {
    const { app } = createTestApp(async () => createCancellationResult({
      replayed: true,
    }));

    const response = await postCancellation(app);

    expect(response.status).toBe(200);
    expect(response.body.replayed).toBe(true);
    expect(response.body.order.status).toBe('cancelled');
  });

  test('normalizes the run ID and scopes the service call to it', async () => {
    const { app, cancelOrderService } = createTestApp(async () => (
      createCancellationResult({
        runId: 'run-A',
      })
    ));

    const response = await postCancellation(app, { runId: ' run-A ' });

    expect(response.status).toBe(200);
    expect(cancelOrderService).toHaveBeenCalledTimes(1);
    expect(cancelOrderService).toHaveBeenCalledWith({
      runId: 'run-A',
      orderId: ORDER_OBJECT_ID,
    });
  });

  test.each([
    ['missing run ID', { runId: null }],
    ['malformed run ID', { runId: 'run invalid' }],
    ['malformed order ID', { orderId: 'not-an-order-id' }],
  ])('rejects %s before invoking the service', async (_label, options) => {
    const { app, cancelOrderService } = createTestApp();

    const response = await postCancellation(app, options);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(cancelOrderService).not.toHaveBeenCalled();
  });

  test.each([
    [
      'NOT_FOUND',
      404,
      'NOT_FOUND',
      'Order was not found',
    ],
    [
      'ORDER_ALREADY_PAID',
      409,
      'ORDER_ALREADY_PAID',
      'Paid orders cannot be cancelled',
    ],
    [
      'PAYMENT_OUTCOME_UNKNOWN',
      409,
      'PAYMENT_OUTCOME_UNKNOWN',
      'Payment outcome must be reconciled before cancellation',
    ],
    [
      'ORDER_CANCELLATION_CONFLICT',
      409,
      'ORDER_CANCELLATION_CONFLICT',
      'Order state conflicts with cancellation',
    ],
    [
      'SERVICE_UNAVAILABLE',
      503,
      'SERVICE_UNAVAILABLE',
      'Order payment is temporarily unavailable',
    ],
    [
      'UNEXPECTED_ERROR',
      503,
      'SERVICE_UNAVAILABLE',
      'Order service is temporarily unavailable',
    ],
  ])('maps cancellation service error %s to the contract response', async (
    code,
    status,
    responseCode,
    message,
  ) => {
    const { app } = createTestApp(async () => {
      const error = new Error('internal service details');
      error.code = code;
      throw error;
    });

    const response = await postCancellation(app);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code: responseCode, message } });
    expect(JSON.stringify(response.body)).not.toContain('internal service details');
  });
});

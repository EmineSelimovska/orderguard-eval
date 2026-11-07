import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app.js';

const RUN_ID = 'run-1';
const IDEMPOTENCY_KEY = 'key-1';
const ORDER_OBJECT_ID = '64b000000000000000000001';
const orderResult = {
  order: {
    _id: ORDER_OBJECT_ID,
    runId: RUN_ID,
    status: 'pending_payment',
    items: [{
      productId: 'product-id',
      sku: 'SKU-1',
      quantity: 2,
      unitPriceMinor: 1250,
      lineAmountMinor: 2500,
    }],
    amountMinor: 2500,
    currency: 'USD',
    paymentId: 'payment-id',
    inventoryDisposition: 'held',
  },
  payment: {
    _id: 'payment-id',
    status: 'pending',
    operationKey: 'op-1',
  },
  replayed: false,
};

function createTestApp(
  serviceImplementation = jest.fn().mockResolvedValue(orderResult),
  {
    order = orderResult.order,
    payment = orderResult.payment,
    paymentAttemptImplementation = jest.fn().mockResolvedValue(orderResult),
  } = {},
) {
  const createOrderService = jest.fn(serviceImplementation);
  const attemptPaymentService = jest.fn(paymentAttemptImplementation);
  const OrderModel = {
    findOne: jest.fn().mockResolvedValue(order),
  };
  const PaymentModel = {
    findOne: jest.fn().mockResolvedValue(payment),
  };
  return {
    app: createApp({
      createOrderService,
      attemptPaymentService,
      OrderModel,
      PaymentModel,
    }),
    createOrderService,
    attemptPaymentService,
    OrderModel,
    PaymentModel,
  };
}

function postOrder(app, {
  runId = RUN_ID,
  idempotencyKey = IDEMPOTENCY_KEY,
  body = { sku: 'SKU-1', quantity: 2 },
} = {}) {
  let testRequest = request(app)
    .post('/api/orders')
    .send(body);

  if (runId !== null) {
    testRequest = testRequest.set('X-Benchmark-Run-Id', runId);
  }
  if (idempotencyKey !== null) {
    testRequest = testRequest.set('Idempotency-Key', idempotencyKey);
  }

  return testRequest;
}

function postPaymentAttempt(app, {
  runId = RUN_ID,
  orderId = `ord_${ORDER_OBJECT_ID}`,
  body,
} = {}) {
  let testRequest = request(app)
    .post(`/api/orders/${orderId}/payment-attempts`);

  if (runId !== null) {
    testRequest = testRequest.set('X-Benchmark-Run-Id', runId);
  }
  if (body !== undefined) {
    testRequest = testRequest.send(body);
  }
  return testRequest;
}

function serviceError(code) {
  const error = new Error('private payment service detail');
  error.code = code;
  return error;
}

describe('POST /api/orders', () => {
  test('creates an order with the contract response and validated service input', async () => {
    const { app, createOrderService } = createTestApp();

    const response = await postOrder(app);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      order: {
        id: `ord_${ORDER_OBJECT_ID}`,
        runId: RUN_ID,
        status: 'pending_payment',
        items: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1250 }],
        amountMinor: 2500,
        currency: 'USD',
        payment: {
          id: 'pay_payment-id',
          status: 'pending',
          operationKey: 'op-1',
        },
        inventoryDisposition: 'held',
      },
      replayed: false,
    });
    expect(createOrderService).toHaveBeenCalledWith({
      runId: RUN_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      orderRequest: { sku: 'SKU-1', quantity: 2 },
    });
  });

  test('returns 200 with replayed true for an exact replay', async () => {
    const serviceReplayResult = {
      order: orderResult.order,
      payment: orderResult.payment,
      replayed: true,
    };
    const { app, createOrderService } = createTestApp(
      async () => serviceReplayResult,
    );

    const response = await postOrder(app);

    expect(response.status).toBe(200);
    expect(response.body.replayed).toBe(true);
    expect(response.body.order.id).toBe(`ord_${ORDER_OBJECT_ID}`);
    expect(createOrderService).toHaveBeenCalledWith({
      runId: RUN_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      orderRequest: { sku: 'SKU-1', quantity: 2 },
    });
  });

  describe('GET /api/orders/:orderId', () => {
    test('returns the run-scoped order with associated payment data', async () => {
      const { app, OrderModel, PaymentModel, createOrderService } = createTestApp();

      const response = await request(app)
        .get(`/api/orders/ord_${ORDER_OBJECT_ID}`)
        .set('X-Benchmark-Run-Id', RUN_ID);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        order: {
          id: `ord_${ORDER_OBJECT_ID}`,
          runId: RUN_ID,
          status: 'pending_payment',
          items: [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 1250 }],
          amountMinor: 2500,
          currency: 'USD',
          payment: {
            id: 'pay_payment-id',
            status: 'pending',
            operationKey: 'op-1',
          },
          inventoryDisposition: 'held',
        },
      });
      expect(OrderModel.findOne).toHaveBeenCalledWith({
        runId: RUN_ID,
        _id: ORDER_OBJECT_ID,
      });
      expect(PaymentModel.findOne).toHaveBeenCalledWith({
        runId: RUN_ID,
        orderId: ORDER_OBJECT_ID,
      });
      expect(createOrderService).not.toHaveBeenCalled();
    });

    test('returns the standard 404 when the Order is absent in this run', async () => {
      const { app, OrderModel, PaymentModel } = createTestApp(undefined, {
        order: null,
      });

      const response = await request(app)
        .get(`/api/orders/ord_${ORDER_OBJECT_ID}`)
        .set('X-Benchmark-Run-Id', RUN_ID);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: { code: 'NOT_FOUND', message: 'Order was not found' },
      });
      expect(OrderModel.findOne).toHaveBeenCalledWith({
        runId: RUN_ID,
        _id: ORDER_OBJECT_ID,
      });
      expect(PaymentModel.findOne).not.toHaveBeenCalled();
    });

    test('returns 400 for a malformed public Order ID', async () => {
      const { app, OrderModel } = createTestApp();

      const response = await request(app)
        .get('/api/orders/not-an-order-id')
        .set('X-Benchmark-Run-Id', RUN_ID);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_REQUEST');
      expect(OrderModel.findOne).not.toHaveBeenCalled();
    });

    test('requires the run-ID header', async () => {
      const { app, OrderModel } = createTestApp();

      const response = await request(app).get(`/api/orders/ord_${ORDER_OBJECT_ID}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_REQUEST');
      expect(OrderModel.findOne).not.toHaveBeenCalled();
    });

    test('returns a safe service-unavailable error when the Order has no Payment', async () => {
      const { app } = createTestApp(undefined, { payment: null });

      const response = await request(app)
        .get(`/api/orders/ord_${ORDER_OBJECT_ID}`)
        .set('X-Benchmark-Run-Id', RUN_ID);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Order payment is temporarily unavailable',
        },
      });
    });
  });

  test('requires a valid run-ID header', async () => {
    const { app, createOrderService } = createTestApp();

    const response = await postOrder(app, { runId: null });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(createOrderService).not.toHaveBeenCalled();
  });

  test('requires the Idempotency-Key header', async () => {
    const { app, createOrderService } = createTestApp();

    const response = await postOrder(app, { idempotencyKey: null });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(createOrderService).not.toHaveBeenCalled();
  });

  test.each([
    ['missing SKU', { quantity: 1 }],
    ['empty SKU', { sku: ' ', quantity: 1 }],
    ['missing quantity', { sku: 'SKU-1' }],
    ['fractional quantity', { sku: 'SKU-1', quantity: 1.5 }],
    ['quantity below minimum', { sku: 'SKU-1', quantity: 0 }],
    ['quantity above maximum', { sku: 'SKU-1', quantity: 101 }],
    ['unexpected field', { sku: 'SKU-1', quantity: 1, runId: 'run-other' }],
  ])('rejects invalid request body: %s', async (_label, body) => {
    const { app, createOrderService } = createTestApp();

    const response = await postOrder(app, { body });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(createOrderService).not.toHaveBeenCalled();
  });

  test.each([
    ['IDEMPOTENCY_KEY_REUSED', 409],
    ['PRODUCT_NOT_FOUND', 404],
    ['INSUFFICIENT_INVENTORY', 409],
    ['VALIDATION_ERROR', 422],
    ['UNEXPECTED_ERROR', 503],
  ])('maps service error %s to HTTP %s', async (code, status) => {
    const { app } = createTestApp(async () => {
      const error = new Error('internal error details');
      error.code = code;
      throw error;
    });

    const response = await postOrder(app);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code === 'UNEXPECTED_ERROR'
      ? 'SERVICE_UNAVAILABLE'
      : code);
    expect(JSON.stringify(response.body)).not.toContain('internal error details');
  });

  test('maps malformed JSON to INVALID_REQUEST', async () => {
    const { app, createOrderService } = createTestApp();
    const response = await request(app)
      .post('/api/orders')
      .set('X-Benchmark-Run-Id', RUN_ID)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .set('Content-Type', 'application/json')
      .send('{"sku":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(createOrderService).not.toHaveBeenCalled();
  });
});

describe('POST /api/orders/:orderId/payment-attempts', () => {
  test('returns the normal success representation and scopes the service input', async () => {
    const successfulResult = {
      order: {
        ...orderResult.order,
        status: 'paid',
        inventoryDisposition: 'consumed',
      },
      payment: { ...orderResult.payment, status: 'succeeded' },
    };
    const { app, attemptPaymentService } = createTestApp(undefined, {
      paymentAttemptImplementation: async () => successfulResult,
    });

    const response = await postPaymentAttempt(app);

    expect(response.status).toBe(200);
    expect(response.body.order).toMatchObject({
      id: `ord_${ORDER_OBJECT_ID}`,
      runId: RUN_ID,
      status: 'paid',
      payment: {
        id: 'pay_payment-id',
        status: 'succeeded',
        operationKey: 'op-1',
      },
    });
    expect(attemptPaymentService).toHaveBeenCalledWith({
      runId: RUN_ID,
      orderId: ORDER_OBJECT_ID,
    });
  });

  test('returns Payment Required for a definitive decline', async () => {
    const declinedResult = {
      order: {
        ...orderResult.order,
        status: 'payment_failed',
        inventoryDisposition: 'released',
      },
      payment: { ...orderResult.payment, status: 'declined' },
    };
    const { app } = createTestApp(undefined, {
      paymentAttemptImplementation: async () => declinedResult,
    });

    const response = await postPaymentAttempt(app);

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({
      error: { code: 'PAYMENT_DECLINED' },
      order: {
        status: 'payment_failed',
        payment: { status: 'declined' },
        inventoryDisposition: 'released',
      },
    });
  });

  test.each([
    ['not_processed', 'pending'],
    ['unknown', 'unknown'],
  ])('returns a 504 timeout with %s state', async (outcome, paymentStatus) => {
    const timeoutResult = {
      ...orderResult,
      payment: { ...orderResult.payment, status: paymentStatus },
      outcome,
    };
    const { app } = createTestApp(undefined, {
      paymentAttemptImplementation: async () => timeoutResult,
    });

    const response = await postPaymentAttempt(app);

    expect(response.status).toBe(504);
    expect(response.body).toEqual({
      error: {
        code: 'PAYMENT_TIMEOUT',
        message: 'Payment outcome requires retry',
      },
      payment: { status: paymentStatus, operationKey: 'op-1' },
      outcome,
    });
  });

  test.each([
    ['missing run ID', { runId: null }],
    ['malformed order ID', { orderId: 'not-an-order-id' }],
    ['client-selected outcome', { body: { outcome: 'success' } }],
    ['client-selected provider key', { body: { operationKey: 'client-key' } }],
  ])('rejects %s before starting a payment attempt', async (_label, options) => {
    const { app, attemptPaymentService } = createTestApp();

    const response = await postPaymentAttempt(app, options);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(attemptPaymentService).not.toHaveBeenCalled();
  });

  test.each([
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['ORDER_NOT_PAYABLE', 409, 'ORDER_NOT_PAYABLE'],
    ['PAYMENT_ATTEMPT_IN_PROGRESS', 409, 'PAYMENT_OUTCOME_UNKNOWN'],
    ['PAYMENT_OUTCOME_CONFLICT', 409, 'PAYMENT_EVENT_CONFLICT'],
    ['UNEXPECTED_ERROR', 503, 'SERVICE_UNAVAILABLE'],
  ])('maps service error %s to a safe HTTP response', async (code, status, responseCode) => {
    const { app } = createTestApp(undefined, {
      paymentAttemptImplementation: async () => { throw serviceError(code); },
    });

    const response = await postPaymentAttempt(app);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(responseCode);
    expect(JSON.stringify(response.body)).not.toContain('private payment service detail');
  });

  test('acknowledges a persisted matching webhook success without retrying the provider', async () => {
    const { app, attemptPaymentService, OrderModel, PaymentModel } = createTestApp(undefined, {
      order: {
        ...orderResult.order,
        status: 'paid',
        inventoryDisposition: 'consumed',
      },
      payment: { ...orderResult.payment, status: 'succeeded' },
      paymentAttemptImplementation: async () => { throw serviceError('ORDER_NOT_PAYABLE'); },
    });

    const response = await postPaymentAttempt(app);

    expect(response.status).toBe(200);
    expect(response.body.order).toMatchObject({
      status: 'paid',
      payment: { status: 'succeeded' },
      inventoryDisposition: 'consumed',
    });
    expect(OrderModel.findOne).toHaveBeenCalledWith({
      runId: RUN_ID,
      _id: ORDER_OBJECT_ID,
    });
    expect(PaymentModel.findOne).toHaveBeenCalledWith({
      runId: RUN_ID,
      _id: orderResult.order.paymentId,
      orderId: ORDER_OBJECT_ID,
    });
    expect(attemptPaymentService).toHaveBeenCalledTimes(1);
  });

  test('acknowledges a persisted matching webhook decline without releasing inventory again', async () => {
    const { app } = createTestApp(undefined, {
      order: {
        ...orderResult.order,
        status: 'payment_failed',
        inventoryDisposition: 'released',
      },
      payment: { ...orderResult.payment, status: 'declined' },
      paymentAttemptImplementation: async () => { throw serviceError('ORDER_NOT_PAYABLE'); },
    });

    const response = await postPaymentAttempt(app);

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({
      error: { code: 'PAYMENT_DECLINED' },
      order: {
        status: 'payment_failed',
        payment: { status: 'declined' },
        inventoryDisposition: 'released',
      },
    });
  });
});

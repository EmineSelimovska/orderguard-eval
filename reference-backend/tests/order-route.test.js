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
  { order = orderResult.order, payment = orderResult.payment } = {},
) {
  const createOrderService = jest.fn(serviceImplementation);
  const OrderModel = {
    findOne: jest.fn().mockResolvedValue(order),
  };
  const PaymentModel = {
    findOne: jest.fn().mockResolvedValue(payment),
  };
  return {
    app: createApp({ createOrderService, OrderModel, PaymentModel }),
    createOrderService,
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

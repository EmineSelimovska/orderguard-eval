import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import {
  createOrder,
  IdempotencyKeyReusedError,
  InsufficientInventoryError,
  OrderAmountValidationError,
  OrderPaymentMissingError,
  ProductNotFoundError,
  validateCreateOrderInput,
} from '../src/services/orders.js';

const validInput = {
  runId: 'run-1',
  idempotencyKey: 'key-1',
  orderRequest: {
    sku: 'SKU-1',
    quantity: 2,
  },
};

const product = {
  _id: 'product-1',
  runId: 'run-1',
  sku: 'SKU-1',
  unitPriceMinor: 1250,
  currency: 'USD',
};

function createSession() {
  let active = false;
  return {
    startTransaction: jest.fn(async () => {
      active = true;
    }),
    commitTransaction: jest.fn(async () => {
      active = false;
    }),
    abortTransaction: jest.fn(async () => {
      active = false;
    }),
    inTransaction: jest.fn(() => active),
    endSession: jest.fn(),
  };
}

function createDependencies({
  existingOrder = null,
  existingPayment = { _id: 'payment-1', status: 'pending', operationKey: 'op-1' },
  reservedProduct = product,
  reservationStatus = 'reserved',
  orderCreate,
  paymentCreate,
  paymentFind,
} = {}) {
  const session = createSession();
  const OrderModel = {
    findOne: jest.fn().mockResolvedValue(existingOrder),
    create: orderCreate ?? jest.fn(async ([document]) => [document]),
  };
  const PaymentModel = {
    findOne: paymentFind ?? jest.fn().mockResolvedValue(existingPayment),
    create: paymentCreate ?? jest.fn(async ([document]) => [document]),
  };
  const inventoryReservation = jest.fn().mockResolvedValue({
    status: reservationStatus,
    product: reservedProduct,
  });
  const startSession = jest.fn().mockResolvedValue(session);

  return {
    session,
    OrderModel,
    PaymentModel,
    inventoryReservation,
    startSession,
    dependencies: {
      OrderModel,
      PaymentModel,
      inventoryReservation,
      startSession,
    },
  };
}

describe('Order creation service interface', () => {
  test('validates and returns the explicit order command shape', () => {
    expect(validateCreateOrderInput(validInput)).toEqual({
      runId: 'run-1',
      idempotencyKey: 'key-1',
      sku: 'SKU-1',
      quantity: 2,
    });
  });

  test.each([1, 100])('accepts contract quantity boundary %s', (quantity) => {
    expect(validateCreateOrderInput({
      ...validInput,
      orderRequest: { sku: 'SKU-1', quantity },
    })).toEqual({
      runId: 'run-1',
      idempotencyKey: 'key-1',
      sku: 'SKU-1',
      quantity,
    });
  });

  test.each([
    ['missing runId', { ...validInput, runId: undefined }],
    ['invalid runId', { ...validInput, runId: 'run invalid' }],
    ['empty idempotencyKey', { ...validInput, idempotencyKey: '  ' }],
    ['missing idempotencyKey', { ...validInput, idempotencyKey: undefined }],
    ['missing request', { ...validInput, orderRequest: undefined }],
    ['empty SKU', { ...validInput, orderRequest: { sku: ' ', quantity: 1 } }],
    ['zero quantity', { ...validInput, orderRequest: { sku: 'SKU-1', quantity: 0 } }],
    ['fractional quantity', { ...validInput, orderRequest: { sku: 'SKU-1', quantity: 1.5 } }],
    ['quantity above contract maximum', { ...validInput, orderRequest: { sku: 'SKU-1', quantity: 101 } }],
  ])('rejects %s', (_description, input) => {
    expect(() => validateCreateOrderInput(input)).toThrow(TypeError);
  });

  test('rejects invalid input before starting a transaction', async () => {
    const mocks = createDependencies();

    await expect(createOrder({
      ...validInput,
      orderRequest: { sku: 'SKU-1', quantity: 0 },
    }, mocks.dependencies)).rejects.toThrow(
      'quantity must be an integer from 1 through 100',
    );
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  test('creates an order and pending payment using the same transaction session', async () => {
    const mocks = createDependencies();

    const result = await createOrder(validInput, mocks.dependencies);

    expect(mocks.OrderModel.findOne).toHaveBeenCalledWith(
      { runId: 'run-1', idempotencyKey: 'key-1' },
      null,
      { session: mocks.session },
    );
    expect(mocks.inventoryReservation).toHaveBeenCalledWith({
      runId: 'run-1',
      sku: 'SKU-1',
      quantity: 2,
      session: mocks.session,
    });

    const [orderDocuments, orderOptions] = mocks.OrderModel.create.mock.calls[0];
    const [paymentDocuments, paymentOptions] = mocks.PaymentModel.create.mock.calls[0];
    const [createdOrder] = orderDocuments;
    const [createdPayment] = paymentDocuments;

    expect(orderOptions).toEqual({ session: mocks.session });
    expect(paymentOptions).toEqual({ session: mocks.session });
    expect(createdOrder).toMatchObject({
      runId: 'run-1',
      idempotencyKey: 'key-1',
      requestHash: createHash('sha256')
        .update(JSON.stringify({ sku: 'SKU-1', quantity: 2 }))
        .digest('hex'),
      items: [{
        productId: 'product-1',
        sku: 'SKU-1',
        quantity: 2,
        unitPriceMinor: 1250,
        lineAmountMinor: 2500,
      }],
      amountMinor: 2500,
      currency: 'USD',
      status: 'pending_payment',
      inventoryDisposition: 'held',
    });
    expect(createdPayment).toMatchObject({
      runId: 'run-1',
      orderId: String(createdOrder._id),
      operationKey: expect.stringMatching(/^op_/),
      status: 'pending',
      amountMinor: 2500,
      currency: 'USD',
      attemptCount: 0,
      lastSafeOutcome: 'pending',
    });
    expect(createdOrder.paymentId).toBe(String(createdPayment._id));
    expect(result).toEqual({
      order: createdOrder,
      payment: createdPayment,
      replayed: false,
    });
    expect(mocks.session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.abortTransaction).not.toHaveBeenCalled();
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
  });

  test('returns an existing order as a replay without reserving or creating records', async () => {
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ sku: 'SKU-1', quantity: 2 }))
      .digest('hex');
    const existingOrder = { _id: 'order-1', requestHash };
    const existingPayment = {
      _id: 'payment-1',
      status: 'pending',
      operationKey: 'op-1',
    };
    const mocks = createDependencies({ existingOrder, existingPayment });

    await expect(createOrder(validInput, mocks.dependencies)).resolves.toEqual({
      order: existingOrder,
      payment: existingPayment,
      replayed: true,
    });
    expect(mocks.PaymentModel.findOne).toHaveBeenCalledWith(
      { runId: 'run-1', orderId: 'order-1' },
      null,
      { session: mocks.session },
    );
    expect(mocks.inventoryReservation).not.toHaveBeenCalled();
    expect(mocks.OrderModel.create).not.toHaveBeenCalled();
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
    expect(mocks.session.commitTransaction).toHaveBeenCalledTimes(1);
  });

  test('does not report a replay when the existing order payment is missing', async () => {
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ sku: 'SKU-1', quantity: 2 }))
      .digest('hex');
    const existingOrder = { _id: 'order-1', requestHash };
    const mocks = createDependencies({
      existingOrder,
      existingPayment: null,
    });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toBeInstanceOf(
      OrderPaymentMissingError,
    );

    expect(mocks.PaymentModel.findOne).toHaveBeenCalledWith(
      { runId: 'run-1', orderId: 'order-1' },
      null,
      { session: mocks.session },
    );
    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.commitTransaction).not.toHaveBeenCalled();
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
  });

  test('aborts when an idempotency key is reused with a different request', async () => {
    const mocks = createDependencies({
      existingOrder: { requestHash: 'different-request-hash' },
    });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.commitTransaction).not.toHaveBeenCalled();
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
  });

  test('conflicts when the same run and key were used with a different SKU', async () => {
    const conflictingHash = createHash('sha256')
      .update(JSON.stringify({ sku: 'SKU-2', quantity: 2 }))
      .digest('hex');
    const mocks = createDependencies({
      existingOrder: { requestHash: conflictingHash },
    });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });

    expect(mocks.OrderModel.findOne).toHaveBeenCalledWith(
      { runId: validInput.runId, idempotencyKey: validInput.idempotencyKey },
      null,
      { session: mocks.session },
    );
    expect(mocks.inventoryReservation).not.toHaveBeenCalled();
    expect(mocks.OrderModel.create).not.toHaveBeenCalled();
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
  });

  test('conflicts when the same run and key were used with a different quantity', async () => {
    const conflictingHash = createHash('sha256')
      .update(JSON.stringify({ sku: 'SKU-1', quantity: 3 }))
      .digest('hex');
    const mocks = createDependencies({
      existingOrder: { requestHash: conflictingHash },
    });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });

    expect(mocks.OrderModel.findOne).toHaveBeenCalledWith(
      { runId: validInput.runId, idempotencyKey: validInput.idempotencyKey },
      null,
      { session: mocks.session },
    );
    expect(mocks.inventoryReservation).not.toHaveBeenCalled();
    expect(mocks.OrderModel.create).not.toHaveBeenCalled();
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
  });

  test.each([
    ['product_not_found', ProductNotFoundError],
    ['insufficient_stock', InsufficientInventoryError],
  ])('aborts when reservation returns %s', async (reservationStatus, ErrorType) => {
    const mocks = createDependencies({ reservationStatus });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toBeInstanceOf(
      ErrorType,
    );
    expect(mocks.OrderModel.create).not.toHaveBeenCalled();
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.commitTransaction).not.toHaveBeenCalled();
  });

  test('aborts the reservation and order if payment creation fails', async () => {
    const paymentError = new Error('payment insert failed');
    const mocks = createDependencies({
      paymentCreate: jest.fn().mockRejectedValue(paymentError),
    });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toBe(paymentError);
    expect(mocks.OrderModel.create).toHaveBeenCalledTimes(1);
    expect(mocks.PaymentModel.create).toHaveBeenCalledTimes(1);
    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.commitTransaction).not.toHaveBeenCalled();
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
  });

  test('aborts the reservation if order creation fails', async () => {
    const orderError = new Error('order insert failed');
    const mocks = createDependencies({
      orderCreate: jest.fn().mockRejectedValue(orderError),
    });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toBe(orderError);
    expect(mocks.OrderModel.create).toHaveBeenCalledTimes(1);
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.commitTransaction).not.toHaveBeenCalled();
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
  });

  test('aborts and looks up the idempotency key after a duplicate-key order insert', async () => {
    const duplicateError = Object.assign(
      new Error('duplicate run-scoped idempotency key'),
      {
        code: 11000,
        keyPattern: { runId: 1, idempotencyKey: 1 },
      },
    );
    const mocks = createDependencies({
      orderCreate: jest.fn().mockRejectedValue(duplicateError),
    });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toBe(
      duplicateError,
    );

    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
    expect(mocks.OrderModel.findOne).toHaveBeenNthCalledWith(
      1,
      { runId: 'run-1', idempotencyKey: 'key-1' },
      null,
      { session: mocks.session },
    );
    expect(mocks.OrderModel.findOne).toHaveBeenNthCalledWith(
      2,
      { runId: 'run-1', idempotencyKey: 'key-1' },
    );
    expect(mocks.inventoryReservation).toHaveBeenCalledTimes(1);
    expect(mocks.OrderModel.create).toHaveBeenCalledTimes(1);
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
  });

  test('returns the winning order as a replay after a duplicate-key insert', async () => {
    const duplicateError = Object.assign(
      new Error('duplicate run-scoped idempotency key'),
      {
        code: 11000,
        keyPattern: { runId: 1, idempotencyKey: 1 },
      },
    );
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ sku: 'SKU-1', quantity: 2 }))
      .digest('hex');
    const winningOrder = { _id: 'order-1', requestHash };
    const winningPayment = {
      _id: 'payment-1',
      status: 'pending',
      operationKey: 'op-1',
    };
    const mocks = createDependencies({
      orderCreate: jest.fn().mockRejectedValue(duplicateError),
      existingPayment: winningPayment,
    });
    mocks.OrderModel.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winningOrder);

    await expect(createOrder(validInput, mocks.dependencies)).resolves.toEqual({
      order: winningOrder,
      payment: winningPayment,
      replayed: true,
    });

    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
    expect(mocks.OrderModel.findOne).toHaveBeenNthCalledWith(
      2,
      { runId: 'run-1', idempotencyKey: 'key-1' },
    );
    expect(mocks.PaymentModel.findOne).toHaveBeenCalledWith({
      runId: 'run-1',
      orderId: 'order-1',
    });
    expect(mocks.inventoryReservation).toHaveBeenCalledTimes(1);
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
  });

  test('returns an idempotency conflict when the winning order has a different request hash', async () => {
    const duplicateError = Object.assign(
      new Error('duplicate run-scoped idempotency key'),
      {
        code: 11000,
        keyPattern: { runId: 1, idempotencyKey: 1 },
      },
    );
    const winningOrder = { requestHash: 'different-request-hash' };
    const mocks = createDependencies({
      orderCreate: jest.fn().mockRejectedValue(duplicateError),
    });
    mocks.OrderModel.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winningOrder);

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toMatchObject({
      name: 'IdempotencyKeyReusedError',
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });

    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
    expect(mocks.OrderModel.findOne).toHaveBeenNthCalledWith(
      2,
      { runId: 'run-1', idempotencyKey: 'key-1' },
    );
    expect(mocks.inventoryReservation).toHaveBeenCalledTimes(1);
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
  });

  test('rethrows duplicate-key errors from another unique index without recovery lookup', async () => {
    const duplicateError = Object.assign(
      new Error('duplicate product reference'),
      {
        code: 11000,
        keyPattern: { productReference: 1 },
      },
    );
    const mocks = createDependencies({
      orderCreate: jest.fn().mockRejectedValue(duplicateError),
    });

    await expect(createOrder(validInput, mocks.dependencies)).rejects.toBe(
      duplicateError,
    );

    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.session.endSession).toHaveBeenCalledTimes(1);
    expect(mocks.OrderModel.findOne).toHaveBeenCalledTimes(1);
    expect(mocks.OrderModel.findOne).toHaveBeenCalledWith(
      { runId: 'run-1', idempotencyKey: 'key-1' },
      null,
      { session: mocks.session },
    );
    expect(mocks.inventoryReservation).toHaveBeenCalledTimes(1);
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
  });

  test('rejects unsupported product totals and aborts the reservation', async () => {
    const mocks = createDependencies({
      reservedProduct: { ...product, unitPriceMinor: 100000000 },
    });

    await expect(createOrder({
      ...validInput,
      orderRequest: { sku: 'SKU-1', quantity: 2 },
    }, mocks.dependencies)).rejects.toBeInstanceOf(OrderAmountValidationError);
    expect(mocks.OrderModel.create).not.toHaveBeenCalled();
    expect(mocks.PaymentModel.create).not.toHaveBeenCalled();
    expect(mocks.session.abortTransaction).toHaveBeenCalledTimes(1);
  });
});

import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import Order from '../models/order.js';
import Payment from '../models/payment.js';
import { reserveInventory } from './inventory.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('Idempotency key was already used with a different order request');
    this.name = 'IdempotencyKeyReusedError';
    this.code = 'IDEMPOTENCY_KEY_REUSED';
    this.status = 409;
  }
}

export class ProductNotFoundError extends Error {
  constructor() {
    super('Product was not found');
    this.name = 'ProductNotFoundError';
    this.code = 'PRODUCT_NOT_FOUND';
    this.status = 404;
  }
}

export class InsufficientInventoryError extends Error {
  constructor() {
    super('Requested quantity is unavailable');
    this.name = 'InsufficientInventoryError';
    this.code = 'INSUFFICIENT_INVENTORY';
    this.status = 409;
  }
}

export class OrderAmountValidationError extends Error {
  constructor() {
    super('Order amount exceeds the supported maximum');
    this.name = 'OrderAmountValidationError';
    this.code = 'VALIDATION_ERROR';
    this.status = 422;
  }
}

export class OrderPaymentMissingError extends Error {
  constructor() {
    super('Payment record for the existing order was not found');
    this.name = 'OrderPaymentMissingError';
    this.code = 'SERVICE_UNAVAILABLE';
    this.status = 503;
  }
}

export function validateCreateOrderInput({
  runId,
  idempotencyKey,
  orderRequest,
} = {}) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError('A valid runId is required');
  }

  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new TypeError('A non-empty idempotencyKey is required');
  }

  if (
    orderRequest === null
    || typeof orderRequest !== 'object'
    || Array.isArray(orderRequest)
  ) {
    throw new TypeError('orderRequest must be an object');
  }

  const { sku, quantity } = orderRequest;
  if (typeof sku !== 'string' || sku.trim().length === 0) {
    throw new TypeError('A non-empty sku is required');
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new TypeError('quantity must be an integer from 1 through 100');
  }

  return { runId, idempotencyKey, sku: sku.trim(), quantity };
}

function hashOrderRequest({ sku, quantity }) {
  const normalizedRequest = JSON.stringify({ sku, quantity });
  return createHash('sha256').update(normalizedRequest).digest('hex');
}

function isDuplicateKeyError(error) {
  const { keyPattern } = error ?? {};
  if (error?.code !== 11000 || !keyPattern || typeof keyPattern !== 'object') {
    return false;
  }

  const fields = Object.keys(keyPattern).sort();
  return fields.length === 2
    && fields[0] === 'idempotencyKey'
    && fields[1] === 'runId'
    && keyPattern.runId === 1
    && keyPattern.idempotencyKey === 1;
}

function isTransientTransactionError(error) {
  return error?.hasErrorLabel?.('TransientTransactionError') === true
    || error?.code === 112;
}



export async function createOrder(input, {
  OrderModel = Order,
  PaymentModel = Payment,
  inventoryReservation = reserveInventory,
  startSession = () => mongoose.startSession(),
  transactionAttempt = 0,
} = {}) {
  const { runId, idempotencyKey, sku, quantity } =
    validateCreateOrderInput(input);

  const requestHash = hashOrderRequest({ sku, quantity });
  const session = await startSession();

  let transactionStarted = false;
  let duplicateOrderCreationError;
  let transactionAborted = false;
  let shouldRetryTransaction = false;

  try {
    await session.startTransaction();
    transactionStarted = true;

    const existingOrder = await OrderModel.findOne(
      { runId, idempotencyKey },
      null,
      { session },
    );

    if (existingOrder) {
      if (existingOrder.requestHash !== requestHash) {
        throw new IdempotencyKeyReusedError();
      }

      const payment = await PaymentModel.findOne(
        { runId, orderId: String(existingOrder._id) },
        null,
        { session },
      );

      if (!payment) {
        throw new OrderPaymentMissingError();
      }

      await session.commitTransaction();
      transactionStarted = false;

      return { order: existingOrder, payment, replayed: true };
    }

    const reservation = await inventoryReservation({
      runId,
      sku,
      quantity,
      session,
    });

    if (reservation.status === 'product_not_found') {
      throw new ProductNotFoundError();
    }

    if (reservation.status === 'insufficient_stock') {
      throw new InsufficientInventoryError();
    }

    if (reservation.status !== 'reserved' || !reservation.product) {
      throw new Error('Inventory reservation returned an invalid result');
    }

    const { product } = reservation;
    const unitPriceMinor = product.unitPriceMinor;
    const lineAmountMinor = unitPriceMinor * quantity;

    if (
      !Number.isSafeInteger(unitPriceMinor)
      || unitPriceMinor < 0
      || unitPriceMinor > 100000000
      || !Number.isSafeInteger(lineAmountMinor)
      || lineAmountMinor > 100000000
      || !['USD', 'EUR', 'GBP'].includes(product.currency)
    ) {
      throw new OrderAmountValidationError();
    }

    const orderId = new mongoose.Types.ObjectId();
    const paymentId = new mongoose.Types.ObjectId();
    const operationKey = `op_${new mongoose.Types.ObjectId().toString()}`;

    const orderData = {
      _id: orderId,
      runId,
      idempotencyKey,
      requestHash,
      items: [{
        productId: String(product._id),
        sku,
        quantity,
        unitPriceMinor,
        lineAmountMinor,
      }],
      amountMinor: lineAmountMinor,
      currency: product.currency,
      status: 'pending_payment',
      paymentId: paymentId.toString(),
      inventoryDisposition: 'held',
      version: 0,
    };

    const paymentData = {
      _id: paymentId,
      runId,
      orderId: orderId.toString(),
      operationKey,
      status: 'pending',
      amountMinor: lineAmountMinor,
      currency: product.currency,
      attemptCount: 0,
      lastSafeOutcome: 'pending',
      providerOperationReference: null,
    };

    let order;

    try {
      [order] = await OrderModel.create([orderData], { session });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        duplicateOrderCreationError = error;
      }
      throw error;
    }

    const [payment] = await PaymentModel.create([paymentData], { session });

    await session.commitTransaction();
    transactionStarted = false;

    return { order, payment, replayed: false };
  } catch (error) {
    if (transactionStarted && session.inTransaction()) {
      try {
        await session.abortTransaction();
        transactionStarted = false;
        transactionAborted = true;
      } catch (abortError) {
        throw new AggregateError(
          [error, abortError],
          'Order creation failed and the transaction could not be aborted',
          { cause: error },
        );
      }
    }

    if (
      transactionAborted
      && transactionAttempt < 5
      && (
        error?.hasErrorLabel?.('TransientTransactionError') === true
        || error?.code === 112
      )
    ) {
      shouldRetryTransaction = true;
    }

    if (!duplicateOrderCreationError || !transactionAborted) {
      if (!shouldRetryTransaction) {
        throw error;
      }
    }
  } finally {
    await session.endSession();
  }

  if (shouldRetryTransaction) {
    return createOrder(input, {
      OrderModel,
      PaymentModel,
      inventoryReservation,
      startSession,
      transactionAttempt: transactionAttempt + 1,
    });
  }

  try {
    const winningOrder = await OrderModel.findOne({
      runId,
      idempotencyKey,
    });

    if (winningOrder) {
      if (winningOrder.requestHash !== requestHash) {
        throw new IdempotencyKeyReusedError();
      }

      const payment = await PaymentModel.findOne({
        runId,
        orderId: String(winningOrder._id),
      });

      if (!payment) {
        throw new OrderPaymentMissingError();
      }

      return { order: winningOrder, payment, replayed: true };
    }
  } catch (lookupError) {
    if (
      lookupError instanceof IdempotencyKeyReusedError
      || lookupError instanceof OrderPaymentMissingError
    ) {
      throw lookupError;
    }

    throw new AggregateError(
      [duplicateOrderCreationError, lookupError],
      'Order creation failed and the follow-up lookup also failed',
      { cause: duplicateOrderCreationError },
    );
  }

  throw duplicateOrderCreationError;
}

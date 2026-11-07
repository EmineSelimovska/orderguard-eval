import mongoose from 'mongoose';
import Order from '../models/order.js';
import Payment from '../models/payment.js';
import Product from '../models/product.js';
import { mockPaymentProviderClient } from '../provider/mock-payment-provider-client.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class PaymentOrderNotFoundError extends Error {
  constructor() {
    super('Order was not found');
    this.name = 'PaymentOrderNotFoundError';
    this.code = 'NOT_FOUND';
    this.status = 404;
  }
}

export class PaymentRecordMissingError extends Error {
  constructor() {
    super('Payment record for the order was not found');
    this.name = 'PaymentRecordMissingError';
    this.code = 'SERVICE_UNAVAILABLE';
    this.status = 503;
  }
}

export class PaymentAttemptAlreadyClaimedError extends Error {
  constructor() {
    super('The payment attempt is no longer available');
    this.name = 'PaymentAttemptAlreadyClaimedError';
    this.code = 'PAYMENT_ATTEMPT_IN_PROGRESS';
    this.status = 409;
  }
}

export class PaymentOrderNotPayableError extends Error {
  constructor() {
    super('Order is not payable');
    this.name = 'PaymentOrderNotPayableError';
    this.code = 'ORDER_NOT_PAYABLE';
    this.status = 409;
  }
}

export class PaymentOutcomeConflictError extends Error {
  constructor() {
    super('Payment outcome could not be applied to the current order state');
    this.name = 'PaymentOutcomeConflictError';
    this.code = 'PAYMENT_OUTCOME_CONFLICT';
    this.status = 409;
  }
}

export class PaymentProviderResultInvalidError extends Error {
  constructor() {
    super('Payment provider returned an invalid charge result');
    this.name = 'PaymentProviderResultInvalidError';
    this.code = 'PAYMENT_PROVIDER_INVALID_RESULT';
    this.status = 502;
  }
}

function isProviderTimeout(error, code) {
  return error?.code === code;
}

async function persistNonterminalOutcome(payment, status, lastSafeOutcome, {
  PaymentModel,
}) {
  const updatedPayment = await PaymentModel.findOneAndUpdate(
    {
      runId: payment.runId,
      _id: payment._id,
      orderId: payment.orderId,
      status: 'processing',
    },
    { $set: { status, lastSafeOutcome } },
    { new: true, runValidators: true },
  );
  if (!updatedPayment) {
    throw new PaymentOutcomeConflictError();
  }
  return updatedPayment;
}

async function persistDefinitiveOutcome(prepared, result, {
  OrderModel,
  PaymentModel,
  ProductModel,
  startSession,
}) {
  const { order, payment } = prepared;
  const succeeded = result.status === 'succeeded';
  const session = await startSession();
  let transactionStarted = false;

  try {
    await session.startTransaction();
    transactionStarted = true;

    const updatedPayment = await PaymentModel.findOneAndUpdate(
      {
        runId: payment.runId,
        _id: payment._id,
        orderId: payment.orderId,
        status: 'processing',
      },
      {
        $set: {
          status: succeeded ? 'succeeded' : 'declined',
          lastSafeOutcome: succeeded ? 'succeeded' : 'declined',
          providerOperationReference: result.providerReference,
          ...(succeeded ? { capturedAt: new Date() } : {}),
        },
      },
      { new: true, runValidators: true, session },
    );
    if (!updatedPayment) {
      throw new PaymentOutcomeConflictError();
    }

    const updatedOrder = await OrderModel.findOneAndUpdate(
      {
        runId: order.runId,
        _id: order._id,
        paymentId: String(payment._id),
        status: 'pending_payment',
        inventoryDisposition: 'held',
        version: order.version,
      },
      {
        $set: {
          status: succeeded ? 'paid' : 'payment_failed',
          inventoryDisposition: succeeded ? 'consumed' : 'released',
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true, session },
    );
    if (!updatedOrder) {
      throw new PaymentOutcomeConflictError();
    }

    if (!succeeded) {
      const item = order.items?.[0];
      if (!item || typeof item.productId !== 'string' || !Number.isInteger(item.quantity)) {
        throw new Error('Order is missing its inventory reservation details');
      }

      const releasedProduct = await ProductModel.findOneAndUpdate(
        { runId: order.runId, _id: item.productId },
        { $inc: { available: item.quantity } },
        { new: true, runValidators: true, session },
      );
      if (!releasedProduct) {
        throw new Error('Product for the held inventory reservation was not found');
      }
    }

    await session.commitTransaction();
    transactionStarted = false;
    return { order: updatedOrder, payment: updatedPayment };
  } catch (error) {
    if (transactionStarted && session.inTransaction()) {
      try {
        await session.abortTransaction();
        transactionStarted = false;
      } catch (abortError) {
        throw new AggregateError(
          [error, abortError],
          'Payment outcome persistence failed and the transaction could not be aborted',
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function preparePaymentAttempt({
  runId,
  orderId,
} = {}, {
  OrderModel = Order,
  PaymentModel = Payment,
  startSession = () => mongoose.startSession(),
} = {}) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError('A valid runId is required');
  }
  if (typeof orderId !== 'string' || orderId.trim().length === 0) {
    throw new TypeError('A non-empty orderId is required');
  }

  const session = await startSession();
  try {
    const claimed = await session.withTransaction(async (transactionSession) => {
      const order = await OrderModel.findOne(
        { runId, _id: orderId },
        null,
        { session: transactionSession },
      );
      if (!order) {
        throw new PaymentOrderNotFoundError();
      }
      if (
        order.status !== 'pending_payment'
        || order.inventoryDisposition !== 'held'
      ) {
        throw new PaymentOrderNotPayableError();
      }

      const storedOrderId = String(order._id);
      const payment = await PaymentModel.findOne(
        {
          runId,
          _id: order.paymentId,
          orderId: storedOrderId,
        },
        null,
        { session: transactionSession },
      );
      if (!payment) {
        throw new PaymentRecordMissingError();
      }
      if (!['pending', 'unknown'].includes(payment.status)) {
        throw new PaymentAttemptAlreadyClaimedError();
      }

      const claimedOrder = await OrderModel.findOneAndUpdate(
        {
          runId,
          _id: order._id,
          paymentId: String(payment._id),
          status: 'pending_payment',
          inventoryDisposition: 'held',
          version: order.version,
        },
        { $inc: { version: 1 } },
        { new: true, runValidators: true, session: transactionSession },
      );
      if (!claimedOrder) {
        throw new PaymentOrderNotPayableError();
      }

      const claimedPayment = await PaymentModel.findOneAndUpdate(
        {
          runId,
          _id: payment._id,
          orderId: storedOrderId,
          status: payment.status,
        },
        {
          $set: { status: 'processing' },
          $inc: { attemptCount: 1 },
        },
        { new: true, runValidators: true, session: transactionSession },
      );
      if (!claimedPayment) {
        throw new PaymentAttemptAlreadyClaimedError();
      }

      return { order: claimedOrder, payment: claimedPayment };
    });

    if (!claimed) {
      throw new Error('Payment claim transaction returned no result');
    }

    return {
      ...claimed,
      operationKey: claimed.payment.operationKey,
    };
  } finally {
    await session.endSession();
  }
}

export async function attemptPayment({
  runId,
  orderId,
} = {}, {
  OrderModel = Order,
  PaymentModel = Payment,
  ProductModel = Product,
  paymentProvider = mockPaymentProviderClient,
  startSession = () => mongoose.startSession(),
} = {}) {
  const prepared = await preparePaymentAttempt(
    { runId, orderId },
    { OrderModel, PaymentModel, startSession },
  );
  const { payment, operationKey } = prepared;

  let result;
  try {
    result = await paymentProvider.charge(
      payment.runId,
      operationKey,
      payment.amountMinor,
      payment.currency,
    );
  } catch (error) {
    if (isProviderTimeout(error, 'NOT_PROCESSED')) {
      const updatedPayment = await persistNonterminalOutcome(
        payment,
        'pending',
        'not_processed',
        { PaymentModel },
      );
      return { order: prepared.order, payment: updatedPayment, outcome: 'not_processed' };
    }
    if (isProviderTimeout(error, 'PROCESSED_RESPONSE_TIMEOUT')) {
      const updatedPayment = await persistNonterminalOutcome(
        payment,
        'unknown',
        'unknown',
        { PaymentModel },
      );
      return { order: prepared.order, payment: updatedPayment, outcome: 'unknown' };
    }
    throw error;
  }

  if (
    !result
    || result.runId !== payment.runId
    || result.operationKey !== operationKey
    || !['succeeded', 'declined'].includes(result.status)
    || typeof result.providerReference !== 'string'
    || result.providerReference.length === 0
  ) {
    throw new PaymentProviderResultInvalidError();
  }

  return persistDefinitiveOutcome(prepared, result, {
    OrderModel,
    PaymentModel,
    ProductModel,
    startSession,
  });
}

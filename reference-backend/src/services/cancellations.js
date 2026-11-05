import mongoose from 'mongoose';
import Order from '../models/order.js';
import Payment from '../models/payment.js';
import Product from '../models/product.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CANCELLABLE_PAYMENT_STATES = new Set(['voided', 'declined', 'refunded']);

export class CancellationOrderNotFoundError extends Error {
  constructor() {
    super('Order was not found');
    this.name = 'CancellationOrderNotFoundError';
    this.code = 'NOT_FOUND';
    this.status = 404;
  }
}

export class CancellationPaymentMissingError extends Error {
  constructor() {
    super('Payment record for the order was not found');
    this.name = 'CancellationPaymentMissingError';
    this.code = 'SERVICE_UNAVAILABLE';
    this.status = 503;
  }
}

export class OrderAlreadyPaidError extends Error {
  constructor() {
    super('Paid orders cannot be cancelled');
    this.name = 'OrderAlreadyPaidError';
    this.code = 'ORDER_ALREADY_PAID';
    this.status = 409;
  }
}

export class PaymentOutcomeUnknownError extends Error {
  constructor() {
    super('Payment outcome must be reconciled before cancellation');
    this.name = 'PaymentOutcomeUnknownError';
    this.code = 'PAYMENT_OUTCOME_UNKNOWN';
    this.status = 409;
  }
}

export class OrderCancellationConflictError extends Error {
  constructor() {
    super('Order state conflicts with cancellation');
    this.name = 'OrderCancellationConflictError';
    this.code = 'ORDER_CANCELLATION_CONFLICT';
    this.status = 409;
  }
}

export async function cancelOrder({
  runId,
  orderId,
} = {}, {
  OrderModel = Order,
  PaymentModel = Payment,
  ProductModel = Product,
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
    const result = await session.withTransaction(async (transactionSession) => {
      const order = await OrderModel.findOne(
        { runId, _id: orderId },
        null,
        { session: transactionSession },
      );
      if (!order) {
        throw new CancellationOrderNotFoundError();
      }

      const payment = await PaymentModel.findOne(
        {
          runId,
          _id: order.paymentId,
          orderId: String(order._id),
        },
        null,
        { session: transactionSession },
      );
      if (!payment) {
        throw new CancellationPaymentMissingError();
      }

      if (order.status === 'paid' && payment.status === 'succeeded') {
        throw new OrderAlreadyPaidError();
      }
      if (['processing', 'unknown'].includes(payment.status)) {
        throw new PaymentOutcomeUnknownError();
      }
      if (order.status === 'cancellation_pending_refund') {
        if (
          payment.status === 'refund_pending'
          && order.inventoryDisposition === 'released'
          && payment.refundOperationKey
        ) {
          return {
            order,
            payment,
            replayed: true,
            httpStatus: 202,
          };
        }
        throw new OrderCancellationConflictError();
      }

      if (
        order.status === 'cancelled'
        && order.inventoryDisposition === 'released'
        && CANCELLABLE_PAYMENT_STATES.has(payment.status)
      ) {
        return { order, payment, replayed: true };
      }

      if (
        order.status === 'pending_payment'
        && order.inventoryDisposition === 'held'
        && payment.status === 'succeeded'
      ) {
        const item = order.items?.[0];
        if (
          !item
          || typeof item.productId !== 'string'
          || item.productId.length === 0
          || !Number.isInteger(item.quantity)
          || item.quantity <= 0
        ) {
          throw new OrderCancellationConflictError();
        }

        const refundOperationKey = payment.refundOperationKey
          || `refund_${payment.operationKey}`;
        const updatedOrder = await OrderModel.findOneAndUpdate(
          {
            runId,
            _id: order._id,
            paymentId: String(payment._id),
            status: 'pending_payment',
            inventoryDisposition: 'held',
            version: order.version,
          },
          {
            $set: {
              status: 'cancellation_pending_refund',
              inventoryDisposition: 'released',
            },
            $inc: { version: 1 },
          },
          { new: true, runValidators: true, session: transactionSession },
        );
        if (!updatedOrder) {
          throw new OrderCancellationConflictError();
        }

        const updatedPayment = await PaymentModel.findOneAndUpdate(
          {
            runId,
            _id: payment._id,
            orderId: String(order._id),
            status: 'succeeded',
          },
          {
            $set: {
              status: 'refund_pending',
              refundOperationKey,
            },
          },
          { new: true, runValidators: true, session: transactionSession },
        );
        if (!updatedPayment) {
          throw new OrderCancellationConflictError();
        }

        const updatedProduct = await ProductModel.findOneAndUpdate(
          { runId, _id: item.productId },
          { $inc: { available: item.quantity } },
          { new: true, runValidators: true, session: transactionSession },
        );
        if (!updatedProduct) {
          throw new Error('Product for the held inventory reservation was not found');
        }

        return {
          order: updatedOrder,
          payment: updatedPayment,
          replayed: false,
          httpStatus: 202,
        };
      }

      if (
        order.status !== 'pending_payment'
        || order.inventoryDisposition !== 'held'
        || payment.status !== 'pending'
      ) {
        if (payment.status === 'succeeded') {
          throw new OrderAlreadyPaidError();
        }
        throw new OrderCancellationConflictError();
      }

      const item = order.items?.[0];
      if (
        !item
        || typeof item.productId !== 'string'
        || item.productId.length === 0
        || !Number.isInteger(item.quantity)
        || item.quantity <= 0
      ) {
        throw new OrderCancellationConflictError();
      }

      const updatedOrder = await OrderModel.findOneAndUpdate(
        {
          runId,
          _id: order._id,
          paymentId: String(payment._id),
          status: 'pending_payment',
          inventoryDisposition: 'held',
          version: order.version,
        },
        {
          $set: {
            status: 'cancelled',
            inventoryDisposition: 'released',
          },
          $inc: { version: 1 },
        },
        { new: true, runValidators: true, session: transactionSession },
      );
      if (!updatedOrder) {
        throw new OrderCancellationConflictError();
      }

      const updatedPayment = await PaymentModel.findOneAndUpdate(
        {
          runId,
          _id: payment._id,
          orderId: String(order._id),
          status: 'pending',
        },
        {
          $set: {
            status: 'voided',
            lastSafeOutcome: 'voided',
          },
        },
        { new: true, runValidators: true, session: transactionSession },
      );
      if (!updatedPayment) {
        throw new OrderCancellationConflictError();
      }

      const updatedProduct = await ProductModel.findOneAndUpdate(
        { runId, _id: item.productId },
        { $inc: { available: item.quantity } },
        { new: true, runValidators: true, session: transactionSession },
      );
      if (!updatedProduct) {
        throw new Error('Product for the held inventory reservation was not found');
      }

      return {
        order: updatedOrder,
        payment: updatedPayment,
        replayed: false,
      };
    });

    if (!result) {
      throw new Error('Order cancellation transaction returned no result');
    }
    return result;
  } finally {
    await session.endSession();
  }
}

import mongoose from 'mongoose';
import Order from '../models/order.js';
import Payment from '../models/payment.js';
import ProcessedWebhook from '../models/processed-webhook.js';
import { mockPaymentProviderClient } from '../provider/mock-payment-provider-client.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class RefundPaymentNotFoundError extends Error {
  constructor() {
    super('Payment was not found');
    this.name = 'RefundPaymentNotFoundError';
    this.code = 'PAYMENT_NOT_FOUND';
    this.status = 404;
  }
}

export class RefundIntentConflictError extends Error {
  constructor(message = 'Persisted refund intent is invalid or incomplete') {
    super(message);
    this.name = 'RefundIntentConflictError';
    this.code = 'REFUND_INTENT_CONFLICT';
    this.status = 409;
  }
}

function assertRefundIntent(payment, order, event, eventId) {
  if (
    !payment
    || !order
    || payment.runId !== order.runId
    || String(order.paymentId) !== String(payment._id)
    || typeof payment.operationKey !== 'string'
    || payment.operationKey.trim().length === 0
    || typeof payment.refundOperationKey !== 'string'
    || payment.refundOperationKey.trim().length === 0
    || order.inventoryDisposition !== 'released'
    || !Number.isInteger(order.version)
  ) {
    throw new RefundIntentConflictError();
  }

  const pending = payment.status === 'refund_pending'
    && order.status === 'cancellation_pending_refund';
  const completed = payment.status === 'refunded'
    && order.status === 'cancelled';
  if (!pending && !completed) {
    throw new RefundIntentConflictError();
  }

  if (eventId !== undefined) {
    if (
      !event
      || event.runId !== payment.runId
      || event.eventId !== eventId
      || event.paymentId !== `pay_${String(payment._id)}`
      || event.operationKey !== payment.operationKey
      || event.type !== 'payment.succeeded'
      || !['refund_pending', 'refund_completed'].includes(event.processingResult)
      || (completed && event.processingResult !== 'refund_completed')
      || (pending && event.processingResult !== 'refund_pending')
    ) {
      throw new RefundIntentConflictError('Webhook refund intent does not match the Payment');
    }
  }

  return completed;
}

async function loadRefundIntent({
  runId,
  paymentId,
  eventId,
  PaymentModel,
  OrderModel,
  ProcessedWebhookModel,
}) {
  const payment = await PaymentModel.findOne({ runId, _id: paymentId });
  if (!payment) {
    throw new RefundPaymentNotFoundError();
  }

  const order = await OrderModel.findOne({
    runId,
    _id: payment.orderId,
    paymentId: String(payment._id),
  });
  const event = eventId === undefined
    ? undefined
    : await ProcessedWebhookModel.findOne({ runId, eventId });

  const completed = assertRefundIntent(payment, order, event, eventId);
  return { payment, order, event, completed };
}

export async function processRefund({
  runId,
  paymentId,
  eventId,
} = {}, {
  OrderModel = Order,
  PaymentModel = Payment,
  ProcessedWebhookModel = ProcessedWebhook,
  refundProvider = mockPaymentProviderClient.refund,
  startSession = () => mongoose.startSession(),
} = {}) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError('A valid runId is required');
  }
  if (typeof paymentId !== 'string' || paymentId.trim().length === 0) {
    throw new TypeError('A non-empty paymentId is required');
  }
  if (
    eventId !== undefined
    && (typeof eventId !== 'string' || eventId.trim().length === 0)
  ) {
    throw new TypeError('A non-empty eventId is required when provided');
  }
  if (typeof refundProvider !== 'function') {
    throw new TypeError('refundProvider must be a function');
  }

  const intent = await loadRefundIntent({
    runId,
    paymentId,
    eventId,
    PaymentModel,
    OrderModel,
    ProcessedWebhookModel,
  });
  if (intent.completed) {
    return {
      payment: intent.payment,
      order: intent.order,
      ...(intent.event ? { event: intent.event } : {}),
      replayed: true,
    };
  }

  const providerResult = await refundProvider(
    runId,
    intent.payment.refundOperationKey,
    intent.payment.operationKey,
  );
  if (
    !providerResult
    || providerResult.runId !== runId
    || providerResult.refundOperationKey !== intent.payment.refundOperationKey
    || providerResult.originalOperationKey !== intent.payment.operationKey
    || providerResult.status !== 'refunded'
    || providerResult.amountMinor !== intent.payment.amountMinor
    || providerResult.currency !== intent.payment.currency
    || typeof providerResult.providerReference !== 'string'
    || providerResult.providerReference.length === 0
  ) {
    throw new RefundIntentConflictError('Refund provider returned an invalid result');
  }

  const session = await startSession();
  try {
    const result = await session.withTransaction(async (transactionSession) => {
      const currentPayment = await PaymentModel.findOne(
        { runId, _id: paymentId },
        null,
        { session: transactionSession },
      );
      if (!currentPayment) {
        throw new RefundPaymentNotFoundError();
      }

      const currentOrder = await OrderModel.findOne(
        {
          runId,
          _id: currentPayment.orderId,
          paymentId: String(currentPayment._id),
        },
        null,
        { session: transactionSession },
      );
      const currentEvent = eventId === undefined
        ? undefined
        : await ProcessedWebhookModel.findOne(
          { runId, eventId },
          null,
          { session: transactionSession },
        );

      const alreadyCompleted = assertRefundIntent(
        currentPayment,
        currentOrder,
        currentEvent,
        eventId,
      );
      if (alreadyCompleted) {
        return {
          payment: currentPayment,
          order: currentOrder,
          ...(currentEvent ? { event: currentEvent } : {}),
          replayed: true,
        };
      }

      const updatedPayment = await PaymentModel.findOneAndUpdate(
        {
          runId,
          _id: currentPayment._id,
          orderId: String(currentOrder._id),
          operationKey: currentPayment.operationKey,
          refundOperationKey: currentPayment.refundOperationKey,
          status: 'refund_pending',
        },
        {
          $set: {
            status: 'refunded',
            lastSafeOutcome: 'refunded',
            refundOperationReference: providerResult.providerReference,
            refundedAt: new Date(),
          },
        },
        { new: true, runValidators: true, session: transactionSession },
      );
      if (!updatedPayment) {
        throw new RefundIntentConflictError('Payment refund intent changed during completion');
      }

      const updatedOrder = await OrderModel.findOneAndUpdate(
        {
          runId,
          _id: currentOrder._id,
          paymentId: String(currentPayment._id),
          status: 'cancellation_pending_refund',
          inventoryDisposition: 'released',
          version: currentOrder.version,
        },
        {
          $set: { status: 'cancelled' },
          $inc: { version: 1 },
        },
        { new: true, runValidators: true, session: transactionSession },
      );
      if (!updatedOrder) {
        throw new RefundIntentConflictError('Order refund intent changed during completion');
      }

      let updatedEvent;
      if (eventId !== undefined) {
        updatedEvent = await ProcessedWebhookModel.findOneAndUpdate(
          {
            runId,
            eventId,
            paymentId: `pay_${String(currentPayment._id)}`,
            operationKey: currentPayment.operationKey,
            type: 'payment.succeeded',
            processingResult: 'refund_pending',
          },
          { $set: { processingResult: 'refund_completed' } },
          { new: true, runValidators: true, session: transactionSession },
        );
        if (!updatedEvent) {
          throw new RefundIntentConflictError('Webhook refund intent changed during completion');
        }
      }

      return {
        payment: updatedPayment,
        order: updatedOrder,
        ...(updatedEvent ? { event: updatedEvent } : {}),
        replayed: false,
      };
    });

    if (!result) {
      throw new Error('Refund completion transaction returned no result');
    }
    return result;
  } finally {
    await session.endSession();
  }
}

import mongoose from 'mongoose';
import Order from '../models/order.js';
import Payment from '../models/payment.js';
import ProcessedWebhook from '../models/processed-webhook.js';
import Product from '../models/product.js';
import { validateAndHashPaymentWebhook } from '../utils/payment-webhook-payload.js';

const PUBLIC_PAYMENT_ID_PATTERN = /^pay_([a-f\d]{24})$/i;

export class PaymentWebhookPaymentNotFoundError extends Error {
  constructor() {
    super('Payment was not found');
    this.name = 'PaymentWebhookPaymentNotFoundError';
    this.code = 'PAYMENT_NOT_FOUND';
    this.status = 404;
  }
}

export class PaymentWebhookEventConflictError extends Error {
  constructor() {
    super('Payment webhook conflicts with the persisted payment state');
    this.name = 'PaymentWebhookEventConflictError';
    this.code = 'PAYMENT_EVENT_CONFLICT';
    this.status = 409;
  }
}

export class PaymentWebhookPayloadConflictError extends Error {
  constructor() {
    super('Webhook event ID was already used with a different payload');
    this.name = 'PaymentWebhookPayloadConflictError';
    this.code = 'EVENT_ID_PAYLOAD_CONFLICT';
    this.status = 409;
  }
}

function receipt(canonicalEvent, duplicate) {
  return {
    eventId: canonicalEvent.eventId,
    processingResult: 'applied',
    duplicate,
  };
}

function isMatchingTerminalOutcome(canonicalEvent, payment, order) {
  if (
    canonicalEvent.type === 'payment.succeeded'
    && payment.status === 'succeeded'
    && order.status === 'paid'
    && order.inventoryDisposition === 'consumed'
  ) {
    return true;
  }

  return canonicalEvent.type === 'payment.declined'
    && payment.status === 'declined'
    && order.status === 'payment_failed'
    && order.inventoryDisposition === 'released';
}

function verifyPaymentAndOrder(canonicalEvent, payment, order) {
  if (
    payment.operationKey !== canonicalEvent.operationKey
    || payment.amountMinor !== canonicalEvent.amountMinor
    || payment.currency !== canonicalEvent.currency
    || order.amountMinor !== canonicalEvent.amountMinor
    || order.currency !== canonicalEvent.currency
    || String(order.paymentId) !== String(payment._id)
  ) {
    throw new PaymentWebhookEventConflictError();
  }
}

async function findStoredEvent(ProcessedWebhookModel, runId, eventId) {
  return ProcessedWebhookModel.findOne({ runId, eventId });
}

function replayReceipt(canonicalEvent, payloadHash, storedEvent) {
  if (storedEvent.payloadHash !== payloadHash) {
    throw new PaymentWebhookPayloadConflictError();
  }
  if (storedEvent.processingResult !== 'applied') {
    throw new PaymentWebhookEventConflictError();
  }
  return receipt(canonicalEvent, true);
}

function webhookEventRecord(canonicalEvent, payloadHash) {
  return {
    runId: canonicalEvent.runId,
    eventId: canonicalEvent.eventId,
    payloadHash,
    paymentId: canonicalEvent.paymentId,
    operationKey: canonicalEvent.operationKey,
    type: canonicalEvent.type,
    processingResult: 'applied',
    processedAt: new Date(),
  };
}

async function findPaymentAndOrder({
  canonicalEvent,
  internalPaymentId,
  PaymentModel,
  OrderModel,
  session,
}) {
  const payment = await PaymentModel.findOne(
    {
      runId: canonicalEvent.runId,
      _id: internalPaymentId,
    },
    null,
    { session },
  );
  if (!payment) {
    throw new PaymentWebhookPaymentNotFoundError();
  }

  const order = await OrderModel.findOne(
    {
      runId: canonicalEvent.runId,
      _id: payment.orderId,
    },
    null,
    { session },
  );
  if (!order) {
    throw new PaymentWebhookEventConflictError();
  }
  verifyPaymentAndOrder(canonicalEvent, payment, order);
  return { payment, order };
}

async function recordMatchingOutcome({
  canonicalEvent,
  payloadHash,
  internalPaymentId,
  OrderModel,
  PaymentModel,
  ProcessedWebhookModel,
  startSession,
}) {
  const session = await startSession();
  try {
    try {
      return await session.withTransaction(async (transactionSession) => {
        const storedEvent = await ProcessedWebhookModel.findOne(
          {
            runId: canonicalEvent.runId,
            eventId: canonicalEvent.eventId,
          },
          null,
          { session: transactionSession },
        );
        if (storedEvent) {
          return replayReceipt(canonicalEvent, payloadHash, storedEvent);
        }

        const { payment, order } = await findPaymentAndOrder({
          canonicalEvent,
          internalPaymentId,
          PaymentModel,
          OrderModel,
          session: transactionSession,
        });
        if (!isMatchingTerminalOutcome(canonicalEvent, payment, order)) {
          throw new PaymentWebhookEventConflictError();
        }

        await ProcessedWebhookModel.create(
          [webhookEventRecord(canonicalEvent, payloadHash)],
          { session: transactionSession },
        );
        return receipt(canonicalEvent, false);
      });
    } catch (error) {
      let storedEvent;
      try {
        storedEvent = await findStoredEvent(
          ProcessedWebhookModel,
          canonicalEvent.runId,
          canonicalEvent.eventId,
        );
      } catch (lookupError) {
        throw new AggregateError(
          [error, lookupError],
          'Payment webhook reconciliation failed and its event could not be read',
          { cause: error },
        );
      }
      if (storedEvent) {
        return replayReceipt(canonicalEvent, payloadHash, storedEvent);
      }
      throw error;
    }
  } finally {
    await session.endSession();
  }
}

export async function processPaymentWebhook({
  runIdHeader,
  body,
} = {}, {
  OrderModel = Order,
  PaymentModel = Payment,
  ProductModel = Product,
  ProcessedWebhookModel = ProcessedWebhook,
  startSession = () => mongoose.startSession(),
} = {}) {
  const { canonicalEvent, payloadHash } = validateAndHashPaymentWebhook({
    runIdHeader,
    body,
  });
  const paymentIdMatch = PUBLIC_PAYMENT_ID_PATTERN.exec(canonicalEvent.paymentId);
  if (!paymentIdMatch) {
    throw new PaymentWebhookPaymentNotFoundError();
  }

  const session = await startSession();
  try {
    try {
      const result = await session.withTransaction(async (transactionSession) => {
        const storedEvent = await ProcessedWebhookModel.findOne(
          {
            runId: canonicalEvent.runId,
            eventId: canonicalEvent.eventId,
          },
          null,
          { session: transactionSession },
        );
        if (storedEvent) {
          return replayReceipt(canonicalEvent, payloadHash, storedEvent);
        }

        const { payment, order } = await findPaymentAndOrder({
          canonicalEvent,
          internalPaymentId: paymentIdMatch[1],
          PaymentModel,
          OrderModel,
          session: transactionSession,
        });

        await ProcessedWebhookModel.create(
          [webhookEventRecord(canonicalEvent, payloadHash)],
          {
            session: transactionSession,
          },
        );

        if (isMatchingTerminalOutcome(canonicalEvent, payment, order)) {
          return receipt(canonicalEvent, false);
        }

        const succeeded = canonicalEvent.type === 'payment.succeeded';
        const allowedPaymentStates = succeeded
          ? ['pending', 'processing', 'unknown']
          : ['processing', 'unknown'];
        if (
          !allowedPaymentStates.includes(payment.status)
          || order.status !== 'pending_payment'
          || order.inventoryDisposition !== 'held'
        ) {
          throw new PaymentWebhookEventConflictError();
        }

        const updatedPayment = await PaymentModel.findOneAndUpdate(
          {
            runId: canonicalEvent.runId,
            _id: payment._id,
            orderId: String(order._id),
            operationKey: canonicalEvent.operationKey,
            amountMinor: canonicalEvent.amountMinor,
            currency: canonicalEvent.currency,
            status: payment.status,
          },
          {
            $set: {
              status: succeeded ? 'succeeded' : 'declined',
              lastSafeOutcome: succeeded ? 'succeeded' : 'declined',
              ...(succeeded ? { capturedAt: new Date() } : {}),
            },
          },
          { new: true, runValidators: true, session: transactionSession },
        );
        if (!updatedPayment) {
          throw new PaymentWebhookEventConflictError();
        }

        const updatedOrder = await OrderModel.findOneAndUpdate(
          {
            runId: canonicalEvent.runId,
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
          { new: true, runValidators: true, session: transactionSession },
        );
        if (!updatedOrder) {
          throw new PaymentWebhookEventConflictError();
        }

        if (!succeeded) {
          const item = order.items?.[0];
          if (
            !item
            || typeof item.productId !== 'string'
            || !item.productId
            || !Number.isInteger(item.quantity)
            || item.quantity <= 0
          ) {
            throw new PaymentWebhookEventConflictError();
          }

          const releasedProduct = await ProductModel.findOneAndUpdate(
            { runId: canonicalEvent.runId, _id: item.productId },
            { $inc: { available: item.quantity } },
            { new: true, runValidators: true, session: transactionSession },
          );
          if (!releasedProduct) {
            throw new Error('Product for the held inventory reservation was not found');
          }
        }

        return receipt(canonicalEvent, false);
      });

      if (!result) {
        throw new Error('Payment webhook transaction returned no result');
      }
      return result;
    } catch (error) {
      let storedEvent;
      try {
        storedEvent = await findStoredEvent(
          ProcessedWebhookModel,
          canonicalEvent.runId,
          canonicalEvent.eventId,
        );
      } catch (lookupError) {
        throw new AggregateError(
          [error, lookupError],
          'Payment webhook failed and its event could not be reconciled',
          { cause: error },
        );
      }
      if (storedEvent) {
        return replayReceipt(canonicalEvent, payloadHash, storedEvent);
      }
      if (error instanceof PaymentWebhookEventConflictError) {
        let currentState;
        try {
          currentState = await findPaymentAndOrder({
            canonicalEvent,
            internalPaymentId: paymentIdMatch[1],
            PaymentModel,
            OrderModel,
          });
        } catch (reconciliationError) {
          if (
            reconciliationError instanceof PaymentWebhookPaymentNotFoundError
            || reconciliationError instanceof PaymentWebhookEventConflictError
          ) {
            throw error;
          }
          throw new AggregateError(
            [error, reconciliationError],
            'Payment webhook outcome could not be reconciled',
            { cause: error },
          );
        }
        if (
          isMatchingTerminalOutcome(
            canonicalEvent,
            currentState.payment,
            currentState.order,
          )
        ) {
          return recordMatchingOutcome({
            canonicalEvent,
            payloadHash,
            internalPaymentId: paymentIdMatch[1],
            OrderModel,
            PaymentModel,
            ProcessedWebhookModel,
            startSession,
          });
        }
      }
      throw error;
    }
  } finally {
    await session.endSession();
  }
}

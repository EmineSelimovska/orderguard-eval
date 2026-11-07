import mongoose from 'mongoose';
import Order from '../models/order.js';
import Payment from '../models/payment.js';
import ProcessedWebhook from '../models/processed-webhook.js';
import Product from '../models/product.js';
import { validateAndHashPaymentWebhook } from '../utils/payment-webhook-payload.js';
import { processRefund } from './refunds.js';

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

function receipt(canonicalEvent, duplicate, processingResult = 'applied') {
  return {
    eventId: canonicalEvent.eventId,
    processingResult,
    duplicate,
  };
}

function matchingTerminalResult(canonicalEvent, payment, order) {
  if (
    canonicalEvent.type === 'payment.succeeded'
    && payment.status === 'succeeded'
    && order.status === 'paid'
    && order.inventoryDisposition === 'consumed'
  ) {
    return 'applied';
  }

  if (
    canonicalEvent.type === 'payment.declined'
    && payment.status === 'declined'
    && order.status === 'payment_failed'
    && order.inventoryDisposition === 'released'
  ) {
    return 'applied';
  }

  if (
    canonicalEvent.type === 'payment.succeeded'
    && payment.status === 'refunded'
    && order.status === 'cancelled'
    && order.inventoryDisposition === 'released'
  ) {
    return 'refund_completed';
  }

  return null;
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
  if (!['applied', 'refund_pending', 'refund_completed'].includes(storedEvent.processingResult)) {
    throw new PaymentWebhookEventConflictError();
  }
  return receipt(canonicalEvent, true, storedEvent.processingResult);
}

function replayOutcome(canonicalEvent, payloadHash, storedEvent) {
  return {
    webhookReceipt: replayReceipt(canonicalEvent, payloadHash, storedEvent),
    resumeRefund: storedEvent.processingResult === 'refund_pending',
  };
}

function webhookOutcome(
  canonicalEvent,
  duplicate,
  processingResult = 'applied',
  resumeRefund = false,
) {
  return {
    webhookReceipt: receipt(canonicalEvent, duplicate, processingResult),
    resumeRefund,
  };
}

async function finishWebhookOutcome({
  result,
  canonicalEvent,
  payloadHash,
  internalPaymentId,
  ProcessedWebhookModel,
  processRefundService,
}) {
  if (result.resumeRefund) {
    try {
      const refundResult = await processRefundService({
        runId: canonicalEvent.runId,
        paymentId: internalPaymentId,
        eventId: canonicalEvent.eventId,
      });
      const completed = refundResult?.event?.processingResult === 'refund_completed'
        || (
          refundResult?.payment?.status === 'refunded'
          && refundResult?.order?.status === 'cancelled'
        );
      return receipt(
        canonicalEvent,
        result.webhookReceipt.duplicate,
        completed ? 'refund_completed' : 'refund_pending',
      );
    } catch (error) {
      const storedEvent = await findStoredEvent(
        ProcessedWebhookModel,
        canonicalEvent.runId,
        canonicalEvent.eventId,
      );
      if (!storedEvent) {
        throw error;
      }
      if (storedEvent.payloadHash !== payloadHash) {
        throw new PaymentWebhookPayloadConflictError();
      }
      if (storedEvent.processingResult === 'refund_pending') {
        return receipt(
          canonicalEvent,
          result.webhookReceipt.duplicate,
          'refund_pending',
        );
      }
      if (storedEvent.processingResult === 'refund_completed') {
        return receipt(
          canonicalEvent,
          result.webhookReceipt.duplicate,
          'refund_completed',
        );
      }
      throw error;
    }
  }
  return result.webhookReceipt;
}

function webhookEventRecord(canonicalEvent, payloadHash, processingResult = 'applied') {
  return {
    runId: canonicalEvent.runId,
    eventId: canonicalEvent.eventId,
    payloadHash,
    paymentId: canonicalEvent.paymentId,
    operationKey: canonicalEvent.operationKey,
    type: canonicalEvent.type,
    processingResult,
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
        const processingResult = matchingTerminalResult(canonicalEvent, payment, order);
        if (!processingResult) {
          throw new PaymentWebhookEventConflictError();
        }

        await ProcessedWebhookModel.create(
          [webhookEventRecord(canonicalEvent, payloadHash, processingResult)],
          { session: transactionSession },
        );
        return receipt(canonicalEvent, false, processingResult);
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
  processRefundService = processRefund,
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
  let result;
  try {
    try {
      result = await session.withTransaction(async (transactionSession) => {
        const storedEvent = await ProcessedWebhookModel.findOne(
          {
            runId: canonicalEvent.runId,
            eventId: canonicalEvent.eventId,
          },
          null,
          { session: transactionSession },
        );
        if (storedEvent) {
          return replayOutcome(canonicalEvent, payloadHash, storedEvent);
        }

        const { payment, order } = await findPaymentAndOrder({
          canonicalEvent,
          internalPaymentId: paymentIdMatch[1],
          PaymentModel,
          OrderModel,
          session: transactionSession,
        });

        const matchingResult = matchingTerminalResult(canonicalEvent, payment, order);
        if (matchingResult) {
          await ProcessedWebhookModel.create(
            [webhookEventRecord(canonicalEvent, payloadHash, matchingResult)],
            { session: transactionSession },
          );
          return webhookOutcome(canonicalEvent, false, matchingResult);
        }

        const succeeded = canonicalEvent.type === 'payment.succeeded';
        if (
          succeeded
          && ['voided', 'succeeded', 'refund_pending'].includes(payment.status)
          && ['cancelled', 'cancellation_pending_refund'].includes(order.status)
          && order.inventoryDisposition === 'released'
          && (
            payment.status !== 'refund_pending'
            || order.status === 'cancellation_pending_refund'
          )
        ) {
          const refundOperationKey = payment.refundOperationKey
            || `refund_${payment.operationKey}`;
          if (order.status === 'cancelled') {
            const updatedOrder = await OrderModel.findOneAndUpdate(
              {
                runId: canonicalEvent.runId,
                _id: order._id,
                paymentId: String(payment._id),
                status: 'cancelled',
                inventoryDisposition: 'released',
                version: order.version,
              },
              {
                $set: { status: 'cancellation_pending_refund' },
                $inc: { version: 1 },
              },
              { new: true, runValidators: true, session: transactionSession },
            );
            if (!updatedOrder) {
              throw new PaymentWebhookEventConflictError();
            }
          }

          const updatedPayment = await PaymentModel.findOneAndUpdate(
            {
              runId: canonicalEvent.runId,
              _id: payment._id,
              orderId: String(order._id),
              operationKey: canonicalEvent.operationKey,
              status: payment.status,
            },
            {
              $set: {
                status: 'refund_pending',
                lastSafeOutcome: 'succeeded',
                refundOperationKey,
                ...(!payment.capturedAt ? { capturedAt: new Date() } : {}),
              },
            },
            { new: true, runValidators: true, session: transactionSession },
          );
          if (!updatedPayment) {
            throw new PaymentWebhookEventConflictError();
          }

          await ProcessedWebhookModel.create(
            [webhookEventRecord(canonicalEvent, payloadHash, 'refund_pending')],
            { session: transactionSession },
          );
          return webhookOutcome(canonicalEvent, false, 'refund_pending', true);
        }

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

        await ProcessedWebhookModel.create(
          [webhookEventRecord(canonicalEvent, payloadHash)],
          { session: transactionSession },
        );

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

        return webhookOutcome(canonicalEvent, false);
      });

      if (!result || !result.webhookReceipt) {
        throw new Error('Payment webhook transaction returned no result');
      }
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
        result = replayOutcome(canonicalEvent, payloadHash, storedEvent);
      } else {
        if (!(error instanceof PaymentWebhookEventConflictError)) {
          throw error;
        }
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
          matchingTerminalResult(
            canonicalEvent,
            currentState.payment,
            currentState.order,
          )
        ) {
          result = {
            webhookReceipt: await recordMatchingOutcome({
              canonicalEvent,
              payloadHash,
              internalPaymentId: paymentIdMatch[1],
              OrderModel,
              PaymentModel,
              ProcessedWebhookModel,
              startSession,
            }),
            resumeRefund: false,
          };
        } else {
          throw error;
        }
      }
    }
  } finally {
    await session.endSession();
  }
  return finishWebhookOutcome({
    result,
    canonicalEvent,
    payloadHash,
    internalPaymentId: paymentIdMatch[1],
    ProcessedWebhookModel,
    processRefundService,
  });
}

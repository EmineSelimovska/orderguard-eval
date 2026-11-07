import express from 'express';
import { requireRunId } from '../middleware/require-run-id.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function errorResponse(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function requireNormalizedRunId(request, response, next) {
  const header = request.get('X-Benchmark-Run-Id');
  const runId = typeof header === 'string' ? header.trim() : header;

  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    return errorResponse(
      response,
      400,
      'INVALID_REQUEST',
      'A valid X-Benchmark-Run-Id header is required',
    );
  }

  request.runId = runId;
  return next();
}

function validateOrderBody(body) {
  return body !== null
    && typeof body === 'object'
    && !Array.isArray(body)
    && Object.keys(body).length === 2
    && Object.hasOwn(body, 'sku')
    && Object.hasOwn(body, 'quantity')
    && typeof body.sku === 'string'
    && body.sku.trim().length > 0
    && Number.isInteger(body.quantity)
    && body.quantity >= 1
    && body.quantity <= 100;
}

function serializeOrder({ order, payment }) {
  return {
    id: `ord_${String(order._id)}`,
    runId: order.runId,
    status: order.status,
    items: order.items.map(({ sku, quantity, unitPriceMinor }) => ({
      sku,
      quantity,
      unitPriceMinor,
    })),
    amountMinor: order.amountMinor,
    currency: order.currency,
    payment: {
      id: `pay_${String(payment._id)}`,
      status: payment.status,
      operationKey: payment.operationKey,
    },
    inventoryDisposition: order.inventoryDisposition,
  };
}

function parseOrderId(orderId) {
  const match = /^ord_([a-f\d]{24})$/i.exec(orderId);
  return match?.[1] ?? null;
}

function hasNoPaymentAttemptOptions(body) {
  return body === undefined
    || (
      body !== null
      && typeof body === 'object'
      && !Array.isArray(body)
      && Object.keys(body).length === 0
    );
}

function declineResponse(response, result) {
  return response.status(402).json({
    error: {
      code: 'PAYMENT_DECLINED',
      message: 'Payment was declined',
    },
    order: serializeOrder(result),
  });
}

async function findMatchingPersistedOutcome(request, OrderModel, PaymentModel) {
  const order = await OrderModel.findOne({
    runId: request.runId,
    _id: request.orderObjectId,
  });
  if (!order) {
    return null;
  }

  const payment = await PaymentModel.findOne({
    runId: request.runId,
    _id: order.paymentId,
    orderId: String(order._id),
  });
  if (!payment || String(order.paymentId) !== String(payment._id)) {
    return null;
  }

  const result = { order, payment };
  if (
    order.status === 'paid'
    && order.inventoryDisposition === 'consumed'
    && payment.status === 'succeeded'
  ) {
    return { type: 'succeeded', result };
  }
  if (
    order.status === 'payment_failed'
    && order.inventoryDisposition === 'released'
    && payment.status === 'declined'
  ) {
    return { type: 'declined', result };
  }
  return null;
}

export function createOrdersRouter({
  createOrderService,
  attemptPaymentService,
  cancelOrderService,
  OrderModel,
  PaymentModel,
}) {
  if (typeof createOrderService !== 'function') {
    throw new TypeError('createOrderService must be a function');
  }
  if (typeof attemptPaymentService !== 'function') {
    throw new TypeError('attemptPaymentService must be a function');
  }
  if (typeof cancelOrderService !== 'function') {
    throw new TypeError('cancelOrderService must be a function');
  }
  if (!OrderModel || !PaymentModel) {
    throw new TypeError('Order and Payment models are required');
  }

  const router = express.Router();
  router.get('/:orderId', requireRunId, async (request, response) => {
    const storedOrderId = parseOrderId(request.params.orderId);
    if (!storedOrderId) {
      return errorResponse(
        response,
        400,
        'INVALID_REQUEST',
        'Order ID is invalid',
      );
    }

    try {
      const order = await OrderModel.findOne({
        runId: request.runId,
        _id: storedOrderId,
      });
      if (!order) {
        return errorResponse(response, 404, 'NOT_FOUND', 'Order was not found');
      }

      const payment = await PaymentModel.findOne({
        runId: request.runId,
        orderId: String(order._id),
      });
      if (!payment) {
        return errorResponse(
          response,
          503,
          'SERVICE_UNAVAILABLE',
          'Order payment is temporarily unavailable',
        );
      }

      return response.status(200).json({ order: serializeOrder({ order, payment }) });
    } catch {
      return errorResponse(
        response,
        503,
        'SERVICE_UNAVAILABLE',
        'Order service is temporarily unavailable',
      );
    }
  });

  router.post('/', requireRunId, async (request, response) => {
    const idempotencyKey = request.get('Idempotency-Key');
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      return errorResponse(
        response,
        400,
        'INVALID_REQUEST',
        'A non-empty Idempotency-Key header is required',
      );
    }

    if (!validateOrderBody(request.body)) {
      return errorResponse(
        response,
        422,
        'VALIDATION_ERROR',
        'Order body must include a non-empty sku and an integer quantity from 1 through 100',
      );
    }

    try {
      const result = await createOrderService({
        runId: request.runId,
        idempotencyKey,
        orderRequest: request.body,
      });

      return response
        .status(result.replayed ? 200 : 201)
        .json({
          order: serializeOrder(result),
          replayed: result.replayed,
        });
    } catch (error) {
      if (error?.code === 'IDEMPOTENCY_KEY_REUSED') {
        return errorResponse(
          response,
          409,
          error.code,
          'Idempotency key was already used with a different order request',
        );
      }

      if (error?.code === 'PRODUCT_NOT_FOUND') {
        return errorResponse(
          response,
          404,
          error.code,
          'Product was not found',
        );
      }

      if (error?.code === 'INSUFFICIENT_INVENTORY') {
        return errorResponse(
          response,
          409,
          error.code,
          'Requested quantity is unavailable',
        );
      }

      if (error?.code === 'VALIDATION_ERROR') {
        return errorResponse(
          response,
          422,
          error.code,
          'Order request is invalid',
        );
      }

      return errorResponse(
        response,
        503,
        'SERVICE_UNAVAILABLE',
        'Order service is temporarily unavailable',
      );
    }
  });

  router.post('/:orderId/payment-attempts', requireRunId, async (request, response) => {
    const orderObjectId = parseOrderId(request.params.orderId);
    if (!orderObjectId) {
      return errorResponse(
        response,
        400,
        'INVALID_REQUEST',
        'Order ID is invalid',
      );
    }
    if (!hasNoPaymentAttemptOptions(request.body)) {
      return errorResponse(
        response,
        400,
        'INVALID_REQUEST',
        'Payment attempt does not accept client-selected options',
      );
    }

    try {
      const result = await attemptPaymentService({
        runId: request.runId,
        orderId: orderObjectId,
      });

      if (
        !result
        || !result.order
        || !result.payment
        || result.order.runId !== request.runId
        || String(result.order.paymentId) !== String(result.payment._id)
      ) {
        throw new Error('Payment service returned an invalid result');
      }

      if (result.outcome === 'not_processed' || result.outcome === 'unknown') {
        const expectedStatus = result.outcome === 'not_processed' ? 'pending' : 'unknown';
        if (result.payment.status !== expectedStatus) {
          throw new Error('Payment service returned an invalid timeout result');
        }
        return response.status(504).json({
          error: {
            code: 'PAYMENT_TIMEOUT',
            message: 'Payment outcome requires retry',
          },
          payment: {
            status: result.payment.status,
            operationKey: result.payment.operationKey,
          },
          outcome: result.outcome,
        });
      }

      if (result.payment.status === 'declined' && result.order.status === 'payment_failed') {
        return declineResponse(response, result);
      }
      if (result.payment.status !== 'succeeded' || result.order.status !== 'paid') {
        throw new Error('Payment service returned an invalid terminal result');
      }
      return response.status(200).json({ order: serializeOrder(result) });
    } catch (error) {
      if (error?.code === 'NOT_FOUND') {
        return errorResponse(response, 404, 'NOT_FOUND', 'Order was not found');
      }
      if (error?.code === 'ORDER_NOT_PAYABLE') {
        try {
          const matchingOutcome = await findMatchingPersistedOutcome(
            { runId: request.runId, orderObjectId },
            OrderModel,
            PaymentModel,
          );
          if (matchingOutcome?.type === 'succeeded') {
            return response.status(200).json({
              order: serializeOrder(matchingOutcome.result),
            });
          }
          if (matchingOutcome?.type === 'declined') {
            return declineResponse(response, matchingOutcome.result);
          }
        } catch {
          return errorResponse(
            response,
            503,
            'SERVICE_UNAVAILABLE',
            'Order service is temporarily unavailable',
          );
        }
        return errorResponse(
          response,
          409,
          'ORDER_NOT_PAYABLE',
          'Order is not payable',
        );
      }
      if (error?.code === 'PAYMENT_ATTEMPT_IN_PROGRESS') {
        return errorResponse(
          response,
          409,
          'PAYMENT_OUTCOME_UNKNOWN',
          'Payment outcome must be reconciled before retrying',
        );
      }
      if (error?.code === 'PAYMENT_OUTCOME_CONFLICT') {
        return errorResponse(
          response,
          409,
          'PAYMENT_EVENT_CONFLICT',
          'Payment outcome conflicts with the persisted state',
        );
      }
      return errorResponse(
        response,
        503,
        'SERVICE_UNAVAILABLE',
        'Payment service is temporarily unavailable',
      );
    }
  });

  router.post('/:orderId/cancel', requireNormalizedRunId, async (request, response) => {
    const storedOrderId = parseOrderId(request.params.orderId);
    if (!storedOrderId) {
      return errorResponse(
        response,
        400,
        'INVALID_REQUEST',
        'Order ID is invalid',
      );
    }

    try {
      const result = await cancelOrderService({
        runId: request.runId,
        orderId: storedOrderId,
      });

      if (
        !result
        || !result.order
        || !result.payment
        || typeof result.replayed !== 'boolean'
        || ![undefined, 200, 202].includes(result.httpStatus)
      ) {
        throw new Error('Cancellation service returned an invalid result');
      }

      return response
        .status(result.httpStatus ?? 200)
        .json({
          order: serializeOrder(result),
          replayed: result.replayed,
        });
    } catch (error) {
      if (error?.code === 'NOT_FOUND') {
        return errorResponse(response, 404, 'NOT_FOUND', 'Order was not found');
      }
      if (error?.code === 'ORDER_ALREADY_PAID') {
        return errorResponse(
          response,
          409,
          'ORDER_ALREADY_PAID',
          'Paid orders cannot be cancelled',
        );
      }
      if (error?.code === 'PAYMENT_OUTCOME_UNKNOWN') {
        return errorResponse(
          response,
          409,
          'PAYMENT_OUTCOME_UNKNOWN',
          'Payment outcome must be reconciled before cancellation',
        );
      }
      if (error?.code === 'ORDER_CANCELLATION_CONFLICT') {
        return errorResponse(
          response,
          409,
          'ORDER_CANCELLATION_CONFLICT',
          'Order state conflicts with cancellation',
        );
      }
      if (error?.code === 'SERVICE_UNAVAILABLE') {
        return errorResponse(
          response,
          503,
          'SERVICE_UNAVAILABLE',
          'Order payment is temporarily unavailable',
        );
      }

      return errorResponse(
        response,
        503,
        'SERVICE_UNAVAILABLE',
        'Order service is temporarily unavailable',
      );
    }
  });

  return router;
}

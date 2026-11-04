import express from 'express';
import { requireRunId } from '../middleware/require-run-id.js';

function errorResponse(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
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

export function createOrdersRouter({
  createOrderService,
  OrderModel,
  PaymentModel,
}) {
  if (typeof createOrderService !== 'function') {
    throw new TypeError('createOrderService must be a function');
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

  return router;
}

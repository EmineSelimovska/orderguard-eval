import express from 'express';
import { validateAndHashPaymentWebhook } from '../utils/payment-webhook-payload.js';

function errorResponse(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function createPaymentWebhooksRouter({ processPaymentWebhookService }) {
  if (typeof processPaymentWebhookService !== 'function') {
    throw new TypeError('processPaymentWebhookService must be a function');
  }

  const router = express.Router();
  router.post('/payments', async (request, response) => {
    let canonicalEvent;
    try {
      ({ canonicalEvent } = validateAndHashPaymentWebhook({
        runIdHeader: request.get('X-Benchmark-Run-Id'),
        body: request.body,
      }));
      request.runId = canonicalEvent.runId;
    } catch (error) {
      if (error?.code === 'INVALID_REQUEST') {
        return errorResponse(
          response,
          400,
          'INVALID_REQUEST',
          'Payment webhook request is invalid',
        );
      }
      throw error;
    }

    try {
      const result = await processPaymentWebhookService({
        runIdHeader: request.runId,
        body: request.body,
      });

      if (
        !result
        || result.eventId !== canonicalEvent.eventId
        || !['applied', 'refund_pending', 'refund_completed']
          .includes(result.processingResult)
        || typeof result.duplicate !== 'boolean'
      ) {
        throw new Error('Payment webhook service returned an invalid result');
      }

      const status = result.processingResult === 'refund_pending' ? 202 : 200;
      return response.status(status).json({
        eventId: result.eventId,
        processingResult: result.processingResult,
        duplicate: result.duplicate,
      });
    } catch (error) {
      if (error?.code === 'PAYMENT_NOT_FOUND') {
        return errorResponse(
          response,
          404,
          'PAYMENT_NOT_FOUND',
          'Payment was not found',
        );
      }
      if (
        error?.code === 'EVENT_ID_PAYLOAD_CONFLICT'
        || error?.code === 'PAYMENT_EVENT_CONFLICT'
      ) {
        return errorResponse(
          response,
          409,
          error.code,
          error.code === 'EVENT_ID_PAYLOAD_CONFLICT'
            ? 'Webhook event ID was already used with a different payload'
            : 'Payment webhook conflicts with the persisted payment state',
        );
      }
      if (error?.code === 'INVALID_REQUEST') {
        return errorResponse(
          response,
          400,
          'INVALID_REQUEST',
          'Payment webhook request is invalid',
        );
      }

      return errorResponse(
        response,
        503,
        'SERVICE_UNAVAILABLE',
        'Payment webhook service is temporarily unavailable',
      );
    }
  });

  return router;
}

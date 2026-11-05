import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app.js';

const RUN_ID = 'run-webhook';
const BODY = {
  eventId: 'evt-1',
  type: 'payment.succeeded',
  paymentId: 'pay_aaaaaaaaaaaaaaaaaaaaaaaa',
  operationKey: 'op-stable-1',
  amountMinor: 2500,
  currency: 'USD',
};

function createTestApp(serviceImplementation = jest.fn().mockResolvedValue({
  eventId: BODY.eventId,
  processingResult: 'applied',
  duplicate: false,
})) {
  const processPaymentWebhookService = jest.fn(serviceImplementation);
  return {
    app: createApp({ processPaymentWebhookService }),
    processPaymentWebhookService,
  };
}

function postWebhook(app, { runId = RUN_ID, body = BODY } = {}) {
  let testRequest = request(app)
    .post('/api/webhooks/payments')
    .send(body);

  if (runId !== null) {
    testRequest = testRequest.set('X-Benchmark-Run-Id', runId);
  }
  return testRequest;
}

describe('POST /api/webhooks/payments', () => {
  test('returns the contract response for a newly applied event', async () => {
    const { app, processPaymentWebhookService } = createTestApp();

    const response = await postWebhook(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      eventId: 'evt-1',
      processingResult: 'applied',
      duplicate: false,
    });
    expect(processPaymentWebhookService).toHaveBeenCalledWith({
      runIdHeader: RUN_ID,
      body: BODY,
    });
  });

  test('returns the exact contract response for a valid declined event', async () => {
    const declinedBody = { ...BODY, type: 'payment.declined' };
    const { app, processPaymentWebhookService } = createTestApp(async () => ({
      eventId: declinedBody.eventId,
      processingResult: 'applied',
      duplicate: false,
    }));

    const response = await postWebhook(app, { body: declinedBody });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      eventId: 'evt-1',
      processingResult: 'applied',
      duplicate: false,
    });
    expect(processPaymentWebhookService).toHaveBeenCalledWith({
      runIdHeader: RUN_ID,
      body: declinedBody,
    });
  });

  test('returns a completed exact replay with duplicate true', async () => {
    const { app } = createTestApp(async () => ({
      eventId: BODY.eventId,
      processingResult: 'applied',
      duplicate: true,
    }));

    const response = await postWebhook(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      eventId: 'evt-1',
      processingResult: 'applied',
      duplicate: true,
    });
  });

  test.each([
    ['pending compensation', 'refund_pending', 202],
    ['completed compensation', 'refund_completed', 200],
  ])('returns %s with its contract status', async (_label, processingResult, status) => {
    const { app } = createTestApp(async () => ({
      eventId: BODY.eventId,
      processingResult,
      duplicate: true,
    }));

    const response = await postWebhook(app);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({
      eventId: BODY.eventId,
      processingResult,
      duplicate: true,
    });
  });

  test.each([
    ['missing run ID header', { runId: null }],
    ['malformed run ID header', { runId: 'run invalid' }],
    ['missing body field', { body: {
      eventId: BODY.eventId,
      type: BODY.type,
      paymentId: BODY.paymentId,
      operationKey: BODY.operationKey,
      amountMinor: BODY.amountMinor,
    } }],
    ['unknown body field', { body: { ...BODY, runId: 'run-other' } }],
  ])('returns 400 for %s before invoking the service', async (_label, options) => {
    const { app, processPaymentWebhookService } = createTestApp();

    const response = await postWebhook(app, options);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Payment webhook request is invalid',
      },
    });
    expect(processPaymentWebhookService).not.toHaveBeenCalled();
  });

  test('trims and validates run ID using the webhook contract normalization', async () => {
    const { app, processPaymentWebhookService } = createTestApp();

    const response = await postWebhook(app, { runId: ' run-A ' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      eventId: 'evt-1',
      processingResult: 'applied',
      duplicate: false,
    });
    expect(processPaymentWebhookService).toHaveBeenCalledTimes(1);
    expect(processPaymentWebhookService).toHaveBeenCalledWith({
      runIdHeader: 'run-A',
      body: BODY,
    });
  });

  test.each([
    [
      'PAYMENT_NOT_FOUND',
      404,
      'PAYMENT_NOT_FOUND',
      'Payment was not found',
    ],
    [
      'EVENT_ID_PAYLOAD_CONFLICT',
      409,
      'EVENT_ID_PAYLOAD_CONFLICT',
      'Webhook event ID was already used with a different payload',
    ],
    [
      'PAYMENT_EVENT_CONFLICT',
      409,
      'PAYMENT_EVENT_CONFLICT',
      'Payment webhook conflicts with the persisted payment state',
    ],
    [
      'INVALID_REQUEST',
      400,
      'INVALID_REQUEST',
      'Payment webhook request is invalid',
    ],
    [
      'UNEXPECTED_ERROR',
      503,
      'SERVICE_UNAVAILABLE',
      'Payment webhook service is temporarily unavailable',
    ],
  ])('maps service error %s to its exact HTTP response', async (
    code,
    status,
    responseCode,
    message,
  ) => {
    const { app } = createTestApp(async () => {
      const error = new Error('private persistence details');
      error.code = code;
      throw error;
    });

    const response = await postWebhook(app);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({
      error: { code: responseCode, message },
    });
    expect(JSON.stringify(response.body)).not.toContain('private persistence details');
  });

  test('returns 400 for malformed JSON', async () => {
    const { app, processPaymentWebhookService } = createTestApp();

    const response = await request(app)
      .post('/api/webhooks/payments')
      .set('X-Benchmark-Run-Id', RUN_ID)
      .set('Content-Type', 'application/json')
      .send('{"eventId":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request body must be valid JSON',
      },
    });
    expect(processPaymentWebhookService).not.toHaveBeenCalled();
  });
});

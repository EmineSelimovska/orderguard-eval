import {
  PaymentWebhookPayloadValidationError,
  validateAndHashPaymentWebhook,
} from '../src/utils/payment-webhook-payload.js';

const runIdHeader = 'run-1';
const validBody = {
  eventId: 'evt-1',
  type: 'payment.succeeded',
  paymentId: 'pay-1',
  operationKey: 'op-1',
  amountMinor: 2500,
  currency: 'USD',
};

describe('Payment webhook payload validation and hashing', () => {
  test('validates a payload and uses the header run ID as the canonical source', () => {
    const result = validateAndHashPaymentWebhook({
      runIdHeader,
      body: validBody,
    });

    expect(result.canonicalEvent).toEqual({
      runId: 'run-1',
      eventId: 'evt-1',
      type: 'payment.succeeded',
      paymentId: 'pay-1',
      operationKey: 'op-1',
      amountMinor: 2500,
      currency: 'USD',
    });
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    ['missing eventId', { ...validBody, eventId: undefined }],
    ['missing type', { ...validBody, type: undefined }],
    ['missing paymentId', { ...validBody, paymentId: undefined }],
    ['missing operationKey', { ...validBody, operationKey: undefined }],
    ['missing amountMinor', { ...validBody, amountMinor: undefined }],
    ['missing currency', { ...validBody, currency: undefined }],
    ['unknown field', { ...validBody, runId: runIdHeader }],
  ])('rejects %s', (_description, body) => {
    expect(() => validateAndHashPaymentWebhook({ runIdHeader, body }))
      .toThrow(PaymentWebhookPayloadValidationError);
  });

  test('rejects a required property that is actually absent', () => {
    const body = { ...validBody };
    delete body.eventId;

    expect(() => validateAndHashPaymentWebhook({ runIdHeader, body }))
      .toThrow(PaymentWebhookPayloadValidationError);
  });

  test('accepts a valid payment.declined payload', () => {
    const result = validateAndHashPaymentWebhook({
      runIdHeader,
      body: { ...validBody, type: 'payment.declined' },
    });

    expect(result.canonicalEvent.type).toBe('payment.declined');
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([0, 100000000])('accepts amount boundary %s', (amountMinor) => {
    const result = validateAndHashPaymentWebhook({
      runIdHeader,
      body: { ...validBody, amountMinor },
    });

    expect(result.canonicalEvent.amountMinor).toBe(amountMinor);
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    ['missing run ID', undefined, validBody],
    ['invalid run ID', 'run invalid', validBody],
    ['null body', runIdHeader, null],
    ['array body', runIdHeader, []],
    ['empty event ID', runIdHeader, { ...validBody, eventId: '  ' }],
    ['non-string payment ID', runIdHeader, { ...validBody, paymentId: 7 }],
    ['empty operation key', runIdHeader, { ...validBody, operationKey: '  ' }],
    ['unsupported type', runIdHeader, { ...validBody, type: 'PAYMENT.SUCCEEDED' }],
    ['non-integer amount', runIdHeader, { ...validBody, amountMinor: 1.5 }],
    ['unsafe amount', runIdHeader, { ...validBody, amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative amount', runIdHeader, { ...validBody, amountMinor: -1 }],
    ['amount above contract limit', runIdHeader, { ...validBody, amountMinor: 100000001 }],
    ['unsupported currency', runIdHeader, { ...validBody, currency: 'CAD' }],
    ['non-string currency', runIdHeader, { ...validBody, currency: 1 }],
  ])('rejects %s', (_description, header, body) => {
    expect(() => validateAndHashPaymentWebhook({
      runIdHeader: header,
      body,
    })).toThrow(PaymentWebhookPayloadValidationError);
  });

  test('trims IDs, preserves their case, and uppercases trimmed currency', () => {
    const result = validateAndHashPaymentWebhook({
      runIdHeader: ' run-A ',
      body: {
        ...validBody,
        eventId: ' EvT-1 ',
        paymentId: ' Pay-AbC ',
        operationKey: ' Op-XyZ ',
        currency: ' usd ',
      },
    });

    expect(result.canonicalEvent).toEqual({
      runId: 'run-A',
      eventId: 'EvT-1',
      type: 'payment.succeeded',
      paymentId: 'Pay-AbC',
      operationKey: 'Op-XyZ',
      amountMinor: 2500,
      currency: 'USD',
    });
  });

  test('produces the same hash for equivalent padded and normalized inputs', () => {
    const normalized = validateAndHashPaymentWebhook({
      runIdHeader: 'run-A',
      body: {
        ...validBody,
        eventId: 'Evt-1',
        paymentId: 'Pay-AbC',
        operationKey: 'Op-XyZ',
        currency: 'USD',
      },
    });
    const padded = validateAndHashPaymentWebhook({
      runIdHeader: ' run-A ',
      body: {
        ...validBody,
        eventId: ' Evt-1 ',
        paymentId: ' Pay-AbC ',
        operationKey: ' Op-XyZ ',
        currency: ' usd ',
      },
    });

    expect(padded.payloadHash).toBe(normalized.payloadHash);
  });

  test('produces different hashes for different header run IDs', () => {
    const first = validateAndHashPaymentWebhook({
      runIdHeader: 'run-1',
      body: validBody,
    });
    const second = validateAndHashPaymentWebhook({
      runIdHeader: 'run-2',
      body: validBody,
    });

    expect(second.payloadHash).not.toBe(first.payloadHash);
  });

  test('produces the same hash independent of request property order', () => {
    const reorderedBody = Object.fromEntries(
      Object.entries(validBody).reverse(),
    );

    const first = validateAndHashPaymentWebhook({
      runIdHeader,
      body: validBody,
    });
    const second = validateAndHashPaymentWebhook({
      runIdHeader,
      body: reorderedBody,
    });

    expect(second.payloadHash).toBe(first.payloadHash);
    expect(first.payloadHash).toBe(
      'f2a5b742743ac7f79827add3ce33f67a7a009e84404fdfcd8a698a10a1fdd70d',
    );
  });
});

import { createHash } from 'node:crypto';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WEBHOOK_FIELDS = [
  'eventId',
  'type',
  'paymentId',
  'operationKey',
  'amountMinor',
  'currency',
];
const WEBHOOK_TYPES = new Set(['payment.succeeded', 'payment.declined']);
const CURRENCIES = new Set(['USD', 'EUR', 'GBP']);
const MAX_AMOUNT_MINOR = 100000000;

export class PaymentWebhookPayloadValidationError extends Error {
  constructor() {
    super('Payment webhook payload is invalid');
    this.name = 'PaymentWebhookPayloadValidationError';
    this.code = 'INVALID_REQUEST';
    this.status = 400;
  }
}

function normalizedIdentifier(value) {
  return typeof value === 'string' ? value.trim() : null;
}

export function validateAndHashPaymentWebhook({ runIdHeader, body } = {}) {
  const runId = normalizedIdentifier(runIdHeader);
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    throw new PaymentWebhookPayloadValidationError();
  }

  if (
    body === null
    || typeof body !== 'object'
    || Array.isArray(body)
  ) {
    throw new PaymentWebhookPayloadValidationError();
  }

  const bodyFields = Object.keys(body);
  if (
    bodyFields.length !== WEBHOOK_FIELDS.length
    || bodyFields.some((field) => !WEBHOOK_FIELDS.includes(field))
    || WEBHOOK_FIELDS.some((field) => !Object.hasOwn(body, field))
  ) {
    throw new PaymentWebhookPayloadValidationError();
  }

  const eventId = normalizedIdentifier(body.eventId);
  const paymentId = normalizedIdentifier(body.paymentId);
  const operationKey = normalizedIdentifier(body.operationKey);
  const currency = typeof body.currency === 'string'
    ? body.currency.trim().toUpperCase()
    : null;

  if (
    !eventId
    || !paymentId
    || !operationKey
    || !WEBHOOK_TYPES.has(body.type)
    || !Number.isSafeInteger(body.amountMinor)
    || body.amountMinor < 0
    || body.amountMinor > MAX_AMOUNT_MINOR
    || !CURRENCIES.has(currency)
  ) {
    throw new PaymentWebhookPayloadValidationError();
  }

  const canonicalEvent = {
    runId,
    eventId,
    type: body.type,
    paymentId,
    operationKey,
    amountMinor: body.amountMinor,
    currency,
  };
  const payloadHash = createHash('sha256')
    .update(JSON.stringify(canonicalEvent), 'utf8')
    .digest('hex');

  return { canonicalEvent, payloadHash };
}

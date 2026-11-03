import Payment from '../src/models/payment.js';

const validPayment = {
  runId: 'run-1',
  orderId: 'order-1',
  operationKey: 'operation-1',
  status: 'pending',
  amountMinor: 2500,
  currency: 'USD',
  lastSafeOutcome: 'pending',
};

describe('Payment model', () => {
  test('requires contract fields and enables timestamps', () => {
    for (const field of [
      'runId',
      'orderId',
      'operationKey',
      'status',
      'amountMinor',
      'currency',
      'attemptCount',
      'lastSafeOutcome',
    ]) {
      expect(Payment.schema.path(field).isRequired).toBe(true);
    }

    expect(Payment.schema.options.timestamps).toBe(true);
    expect(Payment.schema.path('createdAt')).toBeDefined();
    expect(Payment.schema.path('updatedAt')).toBeDefined();
  });

  test('accepts a pending payment and initializes lifecycle fields', async () => {
    const payment = new Payment(validPayment);

    await expect(payment.validate()).resolves.toBeUndefined();
    expect(payment.attemptCount).toBe(0);
    expect(payment.providerOperationReference).toBeNull();
    expect(payment.refundOperationKey).toBeUndefined();
    expect(payment.refundOperationReference).toBeUndefined();
  });

  test.each([
    'pending',
    'processing',
    'unknown',
    'succeeded',
    'declined',
    'voided',
    'refund_pending',
    'refunded',
  ])('accepts payment status %s', async (status) => {
    const payment = new Payment({ ...validPayment, status });

    await expect(payment.validate()).resolves.toBeUndefined();
  });

  test.each([
    ['fractional amount', { amountMinor: 1.5 }],
    ['negative amount', { amountMinor: -1 }],
    ['amount above maximum', { amountMinor: 100000001 }],
    ['fractional attempt count', { attemptCount: 1.5 }],
    ['negative attempt count', { attemptCount: -1 }],
  ])('rejects %s', async (_description, overrides) => {
    const payment = new Payment({ ...validPayment, ...overrides });

    await expect(payment.validate()).rejects.toBeInstanceOf(Error);
  });

  test.each([
    ['status', 'failed'],
    ['currency', 'usd'],
  ])('rejects unsupported %s values', async (field, value) => {
    const payment = new Payment({ ...validPayment, [field]: value });

    await expect(payment.validate()).rejects.toMatchObject({
      errors: {
        [field]: expect.any(Error),
      },
    });
  });

  test('accepts capture and refund lifecycle references and timestamps', async () => {
    const payment = new Payment({
      ...validPayment,
      status: 'refunded',
      attemptCount: 1,
      lastSafeOutcome: 'refunded',
      providerOperationReference: 'provider-charge-1',
      refundOperationKey: 'refund-1',
      refundOperationReference: 'provider-refund-1',
      capturedAt: new Date('2026-01-01T00:00:00.000Z'),
      refundedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    await expect(payment.validate()).resolves.toBeUndefined();
  });

  test('declares required unique indexes and a unique present provider reference', () => {
    const indexes = Payment.schema.indexes();

    expect(indexes).toContainEqual([
      { runId: 1, orderId: 1 },
      { unique: true },
    ]);
    expect(indexes).toContainEqual([
      { runId: 1, operationKey: 1 },
      { unique: true },
    ]);
    expect(indexes).toContainEqual([
      { providerOperationReference: 1 },
      {
        unique: true,
        partialFilterExpression: {
          providerOperationReference: { $type: 'string' },
        },
      },
    ]);
  });
});

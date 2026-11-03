import ProcessedWebhook from '../src/models/processed-webhook.js';

const validWebhook = {
  runId: 'run-1',
  eventId: 'evt-1',
  payloadHash: 'canonical-payload-hash',
  paymentId: 'pay-1',
  operationKey: 'op-1',
  type: 'payment.succeeded',
  processingResult: 'applied',
  processedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('ProcessedWebhook model', () => {
  test('requires contract fields and enables timestamps', () => {
    for (const field of [
      'runId',
      'eventId',
      'payloadHash',
      'paymentId',
      'operationKey',
      'type',
      'processingResult',
      'processedAt',
    ]) {
      expect(ProcessedWebhook.schema.path(field).isRequired).toBe(true);
    }

    expect(ProcessedWebhook.schema.options.timestamps).toBe(true);
    expect(ProcessedWebhook.schema.path('createdAt')).toBeDefined();
    expect(ProcessedWebhook.schema.path('updatedAt')).toBeDefined();
  });

  test('accepts a valid processed event and supports both documented event types', async () => {
    for (const type of ['payment.succeeded', 'payment.declined']) {
      const event = new ProcessedWebhook({ ...validWebhook, type });
      await expect(event.validate()).resolves.toBeUndefined();
    }
  });

  test.each([
    ['type', 'payment.refunded'],
    ['type', 'payment.unknown'],
  ])('rejects unsupported event type %s', async (field, value) => {
    const event = new ProcessedWebhook({ ...validWebhook, [field]: value });

    await expect(event.validate()).rejects.toMatchObject({
      errors: {
        [field]: expect.any(Error),
      },
    });
  });

  test.each([
    'runId',
    'eventId',
    'payloadHash',
    'paymentId',
    'operationKey',
    'type',
    'processingResult',
    'processedAt',
  ])('requires %s', async (field) => {
    const event = new ProcessedWebhook({
      ...validWebhook,
      [field]: undefined,
    });

    await expect(event.validate()).rejects.toMatchObject({
      errors: {
        [field]: expect.any(Error),
      },
    });
  });

  test('declares run-scoped event identity and payment history indexes', () => {
    const indexes = ProcessedWebhook.schema.indexes();

    expect(indexes).toContainEqual([
      { runId: 1, eventId: 1 },
      { unique: true },
    ]);
    expect(indexes).toContainEqual([
      { runId: 1, paymentId: 1, processedAt: 1 },
      {},
    ]);
  });
});

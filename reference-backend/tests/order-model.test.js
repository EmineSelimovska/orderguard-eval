import Order from '../src/models/order.js';

const validOrder = {
  runId: 'run-1',
  idempotencyKey: 'key-1',
  requestHash: 'normalized-request-hash',
  items: [{
    productId: 'product-1',
    sku: 'sku-1',
    quantity: 2,
    unitPriceMinor: 1250,
    lineAmountMinor: 2500,
  }],
  amountMinor: 2500,
  currency: 'USD',
  status: 'pending_payment',
  paymentId: 'pay-1',
  inventoryDisposition: 'held',
  version: 0,
};

describe('Order model', () => {
  test('requires contract fields, including the single item snapshot and revision', () => {
    for (const field of [
      'runId',
      'idempotencyKey',
      'requestHash',
      'items',
      'amountMinor',
      'currency',
      'status',
      'paymentId',
      'inventoryDisposition',
      'version',
    ]) {
      expect(Order.schema.path(field).isRequired).toBe(true);
    }

    expect(Order.schema.path('items.productId').isRequired).toBe(true);
    expect(Order.schema.path('items.sku').isRequired).toBe(true);
    expect(Order.schema.path('items.quantity').isRequired).toBe(true);
    expect(Order.schema.path('items.unitPriceMinor').isRequired).toBe(true);
    expect(Order.schema.path('items.lineAmountMinor').isRequired).toBe(true);
    expect(Order.schema.options.timestamps).toBe(true);
    expect(Order.schema.path('createdAt')).toBeDefined();
    expect(Order.schema.path('updatedAt')).toBeDefined();
  });

  test('accepts a valid order and defaults its version revision', async () => {
    const order = new Order({ ...validOrder, version: undefined });

    await expect(order.validate()).resolves.toBeUndefined();
    expect(order.version).toBe(0);
  });

  test.each([
    ['fractional quantity', { items: [{ ...validOrder.items[0], quantity: 1.5 }] }],
    ['quantity below minimum', { items: [{ ...validOrder.items[0], quantity: 0 }] }],
    ['quantity above maximum', { items: [{ ...validOrder.items[0], quantity: 101 }] }],
    ['fractional unit price', { items: [{ ...validOrder.items[0], unitPriceMinor: 1.5 }] }],
    ['negative unit price', { items: [{ ...validOrder.items[0], unitPriceMinor: -1 }] }],
    ['unit price above maximum', { items: [{ ...validOrder.items[0], unitPriceMinor: 100000001 }] }],
    ['negative line amount', { items: [{ ...validOrder.items[0], lineAmountMinor: -1 }] }],
    ['line amount above maximum', { items: [{ ...validOrder.items[0], lineAmountMinor: 100000001 }] }],
    ['fractional amount', { amountMinor: 1.5 }],
    ['negative amount', { amountMinor: -1 }],
    ['amount above maximum', { amountMinor: 100000001 }],
    ['fractional version', { version: 0.5 }],
    ['negative version', { version: -1 }],
  ])('rejects %s', async (_description, overrides) => {
    const order = new Order({ ...validOrder, ...overrides });

    await expect(order.validate()).rejects.toBeInstanceOf(Error);
  });

  test.each([
    ['status', 'unknown'],
    ['inventoryDisposition', 'reserved'],
    ['currency', 'usd'],
  ])('rejects unsupported %s values', async (field, value) => {
    const order = new Order({ ...validOrder, [field]: value });

    await expect(order.validate()).rejects.toMatchObject({
      errors: {
        [field]: expect.any(Error),
      },
    });
  });

  test.each([
    { items: [] },
    { items: [validOrder.items[0], validOrder.items[0]] },
  ])(
    'requires exactly one item snapshot',
    async ({ items }) => {
      const order = new Order({ ...validOrder, items });

      await expect(order.validate()).rejects.toMatchObject({
        errors: {
          items: expect.any(Error),
        },
      });
    },
  );

  test('declares all contract indexes', () => {
    const indexes = Order.schema.indexes();

    expect(indexes).toContainEqual([
      { runId: 1, idempotencyKey: 1 },
      { unique: true },
    ]);
    expect(indexes).toContainEqual([
      { runId: 1, _id: 1 },
      {},
    ]);
    expect(indexes).toContainEqual([
      { runId: 1, createdAt: 1 },
      {},
    ]);
  });
});

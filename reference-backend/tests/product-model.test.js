import Product from '../src/models/product.js';

describe('Product model', () => {
  test('requires contract fields and enables timestamps', () => {
    for (const field of [
      'runId',
      'sku',
      'name',
      'available',
      'unitPriceMinor',
      'currency',
    ]) {
      expect(Product.schema.path(field).isRequired).toBe(true);
    }

    expect(Product.schema.options.timestamps).toBe(true);
    expect(Product.schema.path('createdAt')).toBeDefined();
    expect(Product.schema.path('updatedAt')).toBeDefined();
  });

  test('accepts a valid product', async () => {
    const product = new Product({
      runId: 'run-1',
      sku: 'sku-1',
      name: 'Test product',
      available: 5,
      unitPriceMinor: 1250,
      currency: 'USD',
    });

    await expect(product.validate()).resolves.toBeUndefined();
  });

  test('accepts zero available stock and zero unit price', async () => {
    const product = new Product({
      runId: 'run-1',
      sku: 'sku-1',
      name: 'Test product',
      available: 0,
      unitPriceMinor: 0,
      currency: 'USD',
    });

    await expect(product.validate()).resolves.toBeUndefined();
  });

  test.each(['EUR', 'GBP'])('accepts the %s currency', async (currency) => {
    const product = new Product({
      runId: 'run-1',
      sku: 'sku-1',
      name: 'Test product',
      available: 5,
      unitPriceMinor: 1250,
      currency,
    });

    await expect(product.validate()).resolves.toBeUndefined();
  });

  test.each([
    'runId',
    'sku',
    'name',
    'available',
    'unitPriceMinor',
    'currency',
  ])('rejects a missing required field: %s', async (field) => {
    const productData = {
      runId: 'run-1',
      sku: 'sku-1',
      name: 'Test product',
      available: 5,
      unitPriceMinor: 1250,
      currency: 'USD',
    };
    delete productData[field];

    const product = new Product(productData);

    await expect(product.validate()).rejects.toMatchObject({
      errors: {
        [field]: expect.any(Error),
      },
    });
  });

  test('accepts the maximum unit price', async () => {
    const product = new Product({
      runId: 'run-1',
      sku: 'sku-1',
      name: 'Test product',
      available: 5,
      unitPriceMinor: 100000000,
      currency: 'USD',
    });

    await expect(product.validate()).resolves.toBeUndefined();
  });

  test('rejects a unit price above the maximum', async () => {
    const product = new Product({
      runId: 'run-1',
      sku: 'sku-1',
      name: 'Test product',
      available: 5,
      unitPriceMinor: 100000001,
      currency: 'USD',
    });

    await expect(product.validate()).rejects.toMatchObject({
      errors: {
        unitPriceMinor: expect.any(Error),
      },
    });
  });

  test.each([
    ['available', 1.5],
    ['available', -1],
    ['unitPriceMinor', 1.5],
    ['unitPriceMinor', -1],
  ])('rejects invalid %s value %s', async (field, value) => {
    const product = new Product({
      runId: 'run-1',
      sku: 'sku-1',
      name: 'Test product',
      available: 5,
      unitPriceMinor: 1250,
      currency: 'USD',
      [field]: value,
    });

    await expect(product.validate()).rejects.toMatchObject({
      errors: {
        [field]: expect.any(Error),
      },
    });
  });

  test('rejects currencies outside the contract allowlist', async () => {
    const product = new Product({
      runId: 'run-1',
      sku: 'sku-1',
      name: 'Test product',
      available: 5,
      unitPriceMinor: 1250,
      currency: 'usd',
    });

    await expect(product.validate()).rejects.toMatchObject({
      errors: {
        currency: expect.any(Error),
      },
    });
  });

  test('declares run-scoped uniqueness and cleanup indexes', () => {
    const indexes = Product.schema.indexes();

    expect(indexes).toContainEqual([
      { runId: 1, sku: 1 },
      { unique: true },
    ]);
    expect(indexes).toContainEqual([
      { runId: 1, updatedAt: 1 },
      {},
    ]);
  });
});

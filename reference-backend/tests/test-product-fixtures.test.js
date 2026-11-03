import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app.js';

const TEST_SECRET = 'fixture-test-secret';
const RUN_ID = 'run-1';
const SKU = 'SKU-1';
const PRODUCT_INPUT = {
  name: 'Test item',
  available: 5,
  unitPriceMinor: 1250,
  currency: 'USD',
};

function createProduct(overrides = {}) {
  return {
    runId: RUN_ID,
    sku: SKU,
    ...PRODUCT_INPUT,
    ...overrides,
  };
}

function createModels({
  existingProduct = null,
  activeHeldOrder = null,
  createdProduct,
  updatedProduct,
} = {}) {
  const ProductModel = {
    findOne: jest.fn().mockResolvedValue(existingProduct),
    create: jest.fn().mockResolvedValue(createdProduct ?? createProduct()),
    findOneAndUpdate: jest.fn().mockResolvedValue(
      updatedProduct ?? createProduct(),
    ),
  };
  const OrderModel = {
    exists: jest.fn().mockResolvedValue(activeHeldOrder),
  };

  return { ProductModel, OrderModel };
}

function createTestApp(models, options = {}) {
  return createApp({
    nodeEnv: 'test',
    testSecret: TEST_SECRET,
    ...models,
    ...options,
  });
}

function putFixture(app, {
  runId = RUN_ID,
  sku = SKU,
  headerRunId = runId,
  secret = TEST_SECRET,
  body = PRODUCT_INPUT,
} = {}) {
  let testRequest = request(app)
    .put(`/_test/runs/${encodeURIComponent(runId)}/products/${encodeURIComponent(sku)}`)
    .send(body);

  if (headerRunId !== undefined) {
    testRequest = testRequest.set('X-Benchmark-Run-Id', headerRunId);
  }
  if (typeof secret === 'string') {
    testRequest = testRequest.set('X-Benchmark-Test-Secret', secret);
  }

  return testRequest;
}

describe('test-only product fixture endpoint', () => {
  test.each([
    ['production mode', { nodeEnv: 'production', testSecret: TEST_SECRET }],
    ['test mode without a configured secret', { nodeEnv: 'test', testSecret: '' }],
  ])('is absent in %s', async (_label, options) => {
    const models = createModels();
    const app = createTestApp(models, options);

    await request(app)
      .put(`/_test/runs/${RUN_ID}/products/${SKU}`)
      .expect(404);

    expect(models.ProductModel.findOne).not.toHaveBeenCalled();
  });

  test.each([null, 'incorrect-secret'])(
    'rejects missing or incorrect test secret: %s',
    async (secret) => {
      const models = createModels();
      const response = await putFixture(createTestApp(models), { secret });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: {
          code: 'TEST_ENDPOINTS_DISABLED',
          message: 'Test endpoints are disabled',
        },
      });
      expect(JSON.stringify(response.body)).not.toContain(TEST_SECRET);
      expect(models.ProductModel.findOne).not.toHaveBeenCalled();
    },
  );

  test('creates a new run-scoped product fixture', async () => {
    const product = createProduct();
    const models = createModels({ createdProduct: product });

    const response = await putFixture(createTestApp(models));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ product });
    expect(models.ProductModel.findOne).toHaveBeenCalledWith({
      runId: RUN_ID,
      sku: SKU,
    });
    expect(models.ProductModel.create).toHaveBeenCalledWith({
      runId: RUN_ID,
      sku: SKU,
      ...PRODUCT_INPUT,
    });
    expect(models.OrderModel.exists).not.toHaveBeenCalled();
  });

  test('rejects a path run ID that does not match the validated header', async () => {
    const models = createModels();
    const response = await putFixture(createTestApp(models), {
      runId: 'run-path',
      headerRunId: RUN_ID,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(models.ProductModel.findOne).not.toHaveBeenCalled();
  });

  test('returns the standard invalid-request response for malformed JSON', async () => {
    const models = createModels();
    const response = await request(createTestApp(models))
      .put(`/_test/runs/${RUN_ID}/products/${SKU}`)
      .set('X-Benchmark-Test-Secret', TEST_SECRET)
      .set('X-Benchmark-Run-Id', RUN_ID)
      .set('Content-Type', 'application/json')
      .send('{"name":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request body must be valid JSON',
      },
    });
    expect(models.ProductModel.findOne).not.toHaveBeenCalled();
  });

  test.each([
    ['negative stock', { ...PRODUCT_INPUT, available: -1 }],
    ['fractional stock', { ...PRODUCT_INPUT, available: 1.5 }],
    ['string stock', { ...PRODUCT_INPUT, available: '5' }],
    ['negative price', { ...PRODUCT_INPUT, unitPriceMinor: -1 }],
    ['fractional price', { ...PRODUCT_INPUT, unitPriceMinor: 1.5 }],
    ['price above contract maximum', { ...PRODUCT_INPUT, unitPriceMinor: 100000001 }],
    ['unsupported currency', { ...PRODUCT_INPUT, currency: 'usd' }],
    ['blank name', { ...PRODUCT_INPUT, name: '  ' }],
    ['unexpected field', { ...PRODUCT_INPUT, runId: 'run-other' }],
  ])('rejects invalid product input: %s', async (_label, body) => {
    const models = createModels();
    const response = await putFixture(createTestApp(models), { body });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(models.ProductModel.findOne).not.toHaveBeenCalled();
  });

  test('returns an idempotent success for an unchanged fixture', async () => {
    const product = createProduct();
    const models = createModels({ existingProduct: product });

    const response = await putFixture(createTestApp(models));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ product });
    expect(models.OrderModel.exists).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: 'pending_payment',
      inventoryDisposition: 'held',
    });
    expect(models.ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('updates an existing fixture when no active held orders exist', async () => {
    const existingProduct = createProduct({ available: 2 });
    const updatedProduct = createProduct();
    const models = createModels({
      existingProduct,
      updatedProduct,
    });

    const response = await putFixture(createTestApp(models));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ product: updatedProduct });
    expect(models.OrderModel.exists).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: 'pending_payment',
      inventoryDisposition: 'held',
    });
    expect(models.ProductModel.findOneAndUpdate).toHaveBeenCalledWith(
      { runId: RUN_ID, sku: SKU },
      { $set: PRODUCT_INPUT },
      { new: true, runValidators: true },
    );
  });

  test('blocks changes while this run has active held orders', async () => {
    const models = createModels({
      existingProduct: createProduct({ available: 2 }),
      activeHeldOrder: { _id: 'order-1' },
    });

    const response = await putFixture(createTestApp(models));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PRODUCT_HAS_ACTIVE_ORDERS');
    expect(models.OrderModel.exists).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: 'pending_payment',
      inventoryDisposition: 'held',
    });
    expect(models.ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('blocks an idempotent reset while this run has active held orders', async () => {
    const models = createModels({
      existingProduct: createProduct(),
      activeHeldOrder: { _id: 'order-1' },
    });

    const response = await putFixture(createTestApp(models));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PRODUCT_HAS_ACTIVE_ORDERS');
    expect(models.ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not access models when the run ID header is missing or invalid', async () => {
    const models = createModels();
    const app = createTestApp(models);

    const missingHeader = await request(app)
      .put(`/_test/runs/${RUN_ID}/products/${SKU}`)
      .set('X-Benchmark-Test-Secret', TEST_SECRET)
      .send(PRODUCT_INPUT);
    const invalidHeader = await putFixture(app, {
      headerRunId: 'run invalid',
    });

    expect(missingHeader.status).toBe(400);
    expect(invalidHeader.status).toBe(400);
    expect(missingHeader.body.error.code).toBe('INVALID_REQUEST');
    expect(invalidHeader.body.error.code).toBe('INVALID_REQUEST');
    expect(models.ProductModel.findOne).not.toHaveBeenCalled();
  });

  test('does not cross run boundaries when querying products or held orders', async () => {
    const product = createProduct({ runId: 'run-2', available: 2 });
    const models = createModels({ existingProduct: product });
    const response = await putFixture(createTestApp(models), {
      runId: 'run-2',
      headerRunId: 'run-2',
    });

    expect(response.status).toBe(200);
    expect(models.ProductModel.findOne).toHaveBeenCalledWith({
      runId: 'run-2',
      sku: SKU,
    });
    expect(models.OrderModel.exists).toHaveBeenCalledWith({
      runId: 'run-2',
      status: 'pending_payment',
      inventoryDisposition: 'held',
    });
  });
});

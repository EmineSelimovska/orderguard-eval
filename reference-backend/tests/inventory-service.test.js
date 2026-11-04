import { jest } from '@jest/globals';
import { reserveInventory } from '../src/services/inventory.js';

function createProductModel({ product = null, exists = true } = {}) {
  return {
    findOneAndUpdate: jest.fn().mockResolvedValue(product),
    exists: jest.fn().mockResolvedValue(exists ? { _id: 'product-1' } : null),
  };
}

describe('reserveInventory', () => {
  const request = {
    runId: 'run-1',
    sku: 'sku-1',
    quantity: 2,
  };

  test('atomically decrements stock when enough is available', async () => {
    const updatedProduct = {
      runId: request.runId,
      sku: request.sku,
      available: 3,
    };
    const ProductModel = createProductModel({ product: updatedProduct });

    await expect(reserveInventory({
      ...request,
      ProductModel,
    })).resolves.toEqual({
      status: 'reserved',
      product: updatedProduct,
    });

    expect(ProductModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(ProductModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        runId: request.runId,
        sku: request.sku,
        available: { $gte: request.quantity },
      },
      { $inc: { available: -request.quantity } },
      { new: true, runValidators: true },
    );
    expect(ProductModel.exists).not.toHaveBeenCalled();
  });

  test('reports insufficient stock when the product exists but does not match the stock condition', async () => {
    const ProductModel = createProductModel({ product: null, exists: true });

    await expect(reserveInventory({
      ...request,
      ProductModel,
    })).resolves.toEqual({ status: 'insufficient_stock' });

    expect(ProductModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(ProductModel.exists).toHaveBeenCalledWith({
      runId: request.runId,
      sku: request.sku,
    });
  });

  test('reports a missing product', async () => {
    const ProductModel = createProductModel({ product: null, exists: false });

    await expect(reserveInventory({
      ...request,
      ProductModel,
    })).resolves.toEqual({ status: 'product_not_found' });

    expect(ProductModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(ProductModel.exists).toHaveBeenCalledWith({
      runId: request.runId,
      sku: request.sku,
    });
  });

  test('uses the supplied transaction session for reservation and existence checks', async () => {
    const session = { id: 'transaction-session' };
    const existsQuery = {
      session: jest.fn().mockResolvedValue({ _id: 'product-1' }),
    };
    const ProductModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockReturnValue(existsQuery),
    };

    await expect(reserveInventory({
      ...request,
      ProductModel,
      session,
    })).resolves.toEqual({ status: 'insufficient_stock' });

    expect(ProductModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        runId: request.runId,
        sku: request.sku,
        available: { $gte: request.quantity },
      },
      { $inc: { available: -request.quantity } },
      { new: true, runValidators: true, session },
    );
    expect(ProductModel.exists).toHaveBeenCalledWith({
      runId: request.runId,
      sku: request.sku,
    });
    expect(existsQuery.session).toHaveBeenCalledWith(session);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid quantity %s before querying the model',
    async (quantity) => {
      const ProductModel = createProductModel();

      await expect(reserveInventory({
        ...request,
        quantity,
        ProductModel,
      })).rejects.toThrow('quantity must be a positive integer');

      expect(ProductModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(ProductModel.exists).not.toHaveBeenCalled();
    },
  );
});

import Product from '../models/product.js';

export async function reserveInventory({
  runId,
  sku,
  quantity,
  ProductModel = Product,
  session,
}) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new TypeError('quantity must be a positive integer');
  }

  const filter = {
    runId,
    sku,
    available: { $gte: quantity },
  };
  const updateOptions = { new: true, runValidators: true };
  if (session) {
    updateOptions.session = session;
  }

  const product = await ProductModel.findOneAndUpdate(
    filter,
    { $inc: { available: -quantity } },
    updateOptions,
  );

  if (product) {
    return { status: 'reserved', product };
  }

  const existsQuery = ProductModel.exists({ runId, sku });
  const exists = await (session ? existsQuery.session(session) : existsQuery);
  return {
    status: exists ? 'insufficient_stock' : 'product_not_found',
  };
}

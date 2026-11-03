import Order from './order.js';
import Payment from './payment.js';
import ProcessedWebhook from './processed-webhook.js';
import Product from './product.js';

export const registeredModels = [
  Product,
  Order,
  Payment,
  ProcessedWebhook,
];

export async function initializeModelIndexes(models = registeredModels) {
  for (const model of models) {
    try {
      await model.init();
    } catch (error) {
      throw new Error(
        `Failed to initialize indexes for ${model.modelName}`,
        { cause: error },
      );
    }
  }
}

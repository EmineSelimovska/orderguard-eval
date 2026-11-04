import express from 'express';
import Order from './models/order.js';
import Payment from './models/payment.js';
import Product from './models/product.js';
import { createOrder } from './services/orders.js';
import { createOrdersRouter } from './routes/orders.js';
import { createTestProductFixturesRouter } from './routes/test-product-fixtures.js';

export function createApp({
  nodeEnv = process.env.NODE_ENV,
  testSecret = process.env.BENCHMARK_TEST_SECRET,
  ProductModel = Product,
  OrderModel = Order,
  PaymentModel = Payment,
  createOrderService = createOrder,
} = {}) {
  const app = express();

  app.use(express.json());
  app.use((error, _request, response, next) => {
    if (error?.type === 'entity.parse.failed') {
      return response.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request body must be valid JSON',
        },
      });
    }

    return next(error);
  });
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });
  app.use('/api/orders', createOrdersRouter({
    createOrderService,
    OrderModel,
    PaymentModel,
  }));

  if (
    nodeEnv === 'test'
    && typeof testSecret === 'string'
    && testSecret.length > 0
  ) {
    app.use(
      '/_test',
      createTestProductFixturesRouter({
        testSecret,
        ProductModel,
        OrderModel,
      }),
    );
  }

  return app;
}

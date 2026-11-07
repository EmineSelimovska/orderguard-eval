import express from 'express';
import Order from './models/order.js';
import Payment from './models/payment.js';
import ProcessedWebhook from './models/processed-webhook.js';
import Product from './models/product.js';
import { createOrder } from './services/orders.js';
import { attemptPayment } from './services/payments.js';
import { cancelOrder } from './services/cancellations.js';
import { processPaymentWebhook } from './services/payment-webhooks.js';
import { createOrdersRouter } from './routes/orders.js';
import { createPaymentWebhooksRouter } from './routes/payment-webhooks.js';
import { createTestProductFixturesRouter } from './routes/test-product-fixtures.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUN_CLEANUP_PATH_PATTERN = /^\/_test\/runs\/[^/]+$/;

function createRunActivityTracker() {
  const runs = new Map();

  function getState(runId) {
    let state = runs.get(runId);
    if (!state) {
      state = { activeRequests: 0, cleaning: false };
      runs.set(runId, state);
    }
    return state;
  }

  function removeIfIdle(runId, state) {
    if (state.activeRequests === 0 && !state.cleaning) {
      runs.delete(runId);
    }
  }

  function enter(runId) {
    const state = getState(runId);
    if (state.cleaning) {
      return null;
    }
    state.activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.activeRequests -= 1;
      removeIfIdle(runId, state);
    };
  }

  function beginCleanup(runId) {
    const state = getState(runId);
    if (state.cleaning || state.activeRequests > 0) {
      removeIfIdle(runId, state);
      return null;
    }
    state.cleaning = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.cleaning = false;
      removeIfIdle(runId, state);
    };
  }

  return { enter, beginCleanup };
}

export function createApp({
  nodeEnv = process.env.NODE_ENV,
  testSecret = process.env.BENCHMARK_TEST_SECRET,
  ProductModel = Product,
  OrderModel = Order,
  PaymentModel = Payment,
  ProcessedWebhookModel = ProcessedWebhook,
  createOrderService = createOrder,
  attemptPaymentService = attemptPayment,
  cancelOrderService = cancelOrder,
  processPaymentWebhookService = processPaymentWebhook,
} = {}) {
  const app = express();
  const runActivity = createRunActivityTracker();

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
  app.use((request, response, next) => {
    const isRunScopedRequest = request.path.startsWith('/api/')
      || request.path.startsWith('/_test/');
    if (
      !isRunScopedRequest
      || (
        request.method === 'DELETE'
        && RUN_CLEANUP_PATH_PATTERN.test(request.path)
      )
    ) {
      return next();
    }

    const headerRunId = request.get('X-Benchmark-Run-Id');
    const runId = typeof headerRunId === 'string' ? headerRunId.trim() : '';
    if (!RUN_ID_PATTERN.test(runId)) {
      return next();
    }

    const releaseActivity = runActivity.enter(runId);
    if (!releaseActivity) {
      return response.status(409).json({
        error: {
          code: 'RUN_BUSY',
          message: 'Run cleanup is already in progress',
        },
      });
    }

    response.once('finish', releaseActivity);
    const end = response.end;
    response.end = function (...args) {
      releaseActivity();
      return end.apply(this, args);
    };
    return next();
  });
  app.use('/api/orders', createOrdersRouter({
    createOrderService,
    attemptPaymentService,
    cancelOrderService,
    OrderModel,
    PaymentModel,
  }));
  app.use('/api/webhooks', createPaymentWebhooksRouter({
    processPaymentWebhookService,
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
        PaymentModel,
        ProcessedWebhookModel,
        runActivity,
      }),
    );
  }

  return app;
}

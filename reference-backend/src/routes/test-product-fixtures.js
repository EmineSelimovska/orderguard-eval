import { timingSafeEqual } from "node:crypto";
import express from "express";
import { requireRunId } from "../middleware/require-run-id.js";
import { withRunScope } from "../utils/run-scope.js";

const PRODUCT_FIELDS = ["name", "available", "unitPriceMinor", "currency"];
const CURRENCIES = new Set(["USD", "EUR", "GBP"]);

function isValidTestSecret(suppliedSecret, configuredSecret) {
  if (typeof suppliedSecret !== "string") {
    return false;
  }

  const supplied = Buffer.from(suppliedSecret);
  const configured = Buffer.from(configuredSecret);

  return (
    supplied.length === configured.length &&
    timingSafeEqual(supplied, configured)
  );
}

function errorResponse(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function validateProductInput(request) {
  const { sku } = request.params;
  const body = request.body;

  if (
    typeof sku !== "string" ||
    sku.trim().length === 0 ||
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((field) => !PRODUCT_FIELDS.includes(field)) ||
    PRODUCT_FIELDS.some((field) => !Object.hasOwn(body, field)) ||
    typeof body.name !== "string" ||
    body.name.trim().length === 0 ||
    !Number.isSafeInteger(body.available) ||
    body.available < 0 ||
    !Number.isSafeInteger(body.unitPriceMinor) ||
    body.unitPriceMinor < 0 ||
    body.unitPriceMinor > 100000000 ||
    !CURRENCIES.has(body.currency)
  ) {
    return null;
  }

  return {
    sku: sku.trim(),
    name: body.name.trim(),
    available: body.available,
    unitPriceMinor: body.unitPriceMinor,
    currency: body.currency,
  };
}

function productResponse(product) {
  return {
    runId: product.runId,
    sku: product.sku,
    name: product.name,
    available: product.available,
    unitPriceMinor: product.unitPriceMinor,
    currency: product.currency,
  };
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

export function createTestProductFixturesRouter({
  testSecret,
  ProductModel,
  OrderModel,
  PaymentModel,
  ProcessedWebhookModel,
  runActivity,
}) {
  if (typeof testSecret !== "string" || testSecret.length === 0) {
    throw new TypeError("A configured test secret is required");
  }

  if (!ProductModel || !OrderModel || !PaymentModel || !ProcessedWebhookModel) {
    throw new TypeError(
      "Product, Order, Payment, and ProcessedWebhook models are required",
    );
  }
  if (!runActivity || typeof runActivity.beginCleanup !== "function") {
    throw new TypeError("runActivity cleanup coordination is required");
  }

  const router = express.Router();

  router.use((request, response, next) => {
    if (
      !isValidTestSecret(request.get("X-Benchmark-Test-Secret"), testSecret)
    ) {
      return errorResponse(
        response,
        403,
        "TEST_ENDPOINTS_DISABLED",
        "Test endpoints are disabled",
      );
    }

    return next();
  });

  router.put(
    "/runs/:runId/products/:sku",
    requireRunId,
    async (request, response) => {
      if (request.params.runId !== request.runId) {
        return errorResponse(
          response,
          400,
          "INVALID_REQUEST",
          "Path run ID must match X-Benchmark-Run-Id",
        );
      }

      const input = validateProductInput(request);
      if (!input) {
        return errorResponse(
          response,
          422,
          "VALIDATION_ERROR",
          "Product fields are invalid",
        );
      }

      const productFilter = withRunScope(request, { sku: input.sku });
      const productFields = {
        name: input.name,
        available: input.available,
        unitPriceMinor: input.unitPriceMinor,
        currency: input.currency,
      };

      try {
        let existingProduct = await ProductModel.findOne(productFilter);

        if (!existingProduct) {
          try {
            const createdProduct = await ProductModel.create({
              ...productFilter,
              ...productFields,
            });
            return response.status(201).json({
              product: productResponse(createdProduct),
            });
          } catch (error) {
            if (!isDuplicateKeyError(error)) {
              throw error;
            }
            existingProduct = await ProductModel.findOne(productFilter);
            if (!existingProduct) {
              throw error;
            }
          }
        }

        const activeHeldOrder = await OrderModel.exists(
          withRunScope(request, {
            status: "pending_payment",
            inventoryDisposition: "held",
          }),
        );

        if (activeHeldOrder) {
          return errorResponse(
            response,
            409,
            "PRODUCT_HAS_ACTIVE_ORDERS",
            "Product cannot be reset while the run has active held orders",
          );
        }

        const hasChanges = Object.entries(productFields).some(
          ([field, value]) => existingProduct[field] !== value,
        );

        if (!hasChanges) {
          return response.status(200).json({
            product: productResponse(existingProduct),
          });
        }

        const updatedProduct = await ProductModel.findOneAndUpdate(
          productFilter,
          { $set: productFields },
          { new: true, runValidators: true },
        );

        if (!updatedProduct) {
          return errorResponse(
            response,
            503,
            "SERVICE_UNAVAILABLE",
            "Product fixture could not be updated",
          );
        }

        return response.status(200).json({
          product: productResponse(updatedProduct),
        });
      } catch {
        return errorResponse(
          response,
          503,
          "SERVICE_UNAVAILABLE",
          "Product fixture setup is temporarily unavailable",
        );
      }
    },
  );

  router.get(
    "/runs/:runId/observations",
    requireRunId,
    async (request, response) => {
      if (request.params.runId !== request.runId) {
        return errorResponse(
          response,
          400,
          "INVALID_REQUEST",
          "Path run ID must match X-Benchmark-Run-Id",
        );
      }

      try {
        const runId = request.runId;

        const [products, orders, payments, webhooks] = await Promise.all([
          ProductModel.find({ runId }).lean(),
          OrderModel.find({ runId }).lean(),
          PaymentModel.find({ runId }).lean(),
          ProcessedWebhookModel.find({ runId }).lean(),
        ]);

        return response.status(200).json({
          runId,

          products: products.map((product) => ({
            sku: product.sku,
            name: product.name,
            available: product.available,
            unitPriceMinor: product.unitPriceMinor,
            currency: product.currency,
          })),

          orders: orders.map((order) => ({
            id: `ord_${String(order._id)}`,
            idempotencyKey: order.idempotencyKey,
            quantity: order.items?.[0]?.quantity,
            paymentId: `pay_${String(order.paymentId)}`,
            amountMinor: order.amountMinor,
            currency: order.currency,
            status: order.status,
            inventoryDisposition: order.inventoryDisposition,
          })),

          payments: payments.map((payment) => ({
            id: `pay_${String(payment._id)}`,
            orderId: `ord_${String(payment.orderId)}`,
            operationKey: payment.operationKey,
            status: payment.status,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            attemptCount: payment.attemptCount,
            refundOperationKey: payment.refundOperationKey ?? null,
          })),

          webhooks: webhooks.map((webhook) => ({
            eventId: webhook.eventId,
            paymentId: webhook.paymentId,
            operationKey: webhook.operationKey,
            type: webhook.type,
            processingResult: webhook.processingResult,
          })),
        });
      } catch {
        return errorResponse(
          response,
          503,
          "SERVICE_UNAVAILABLE",
          "Run observations are temporarily unavailable",
        );
      }
    },
  );

  router.delete("/runs/:runId", requireRunId, async (request, response) => {
    if (request.params.runId !== request.runId) {
      return errorResponse(
        response,
        400,
        "INVALID_REQUEST",
        "Path run ID must match X-Benchmark-Run-Id",
      );
    }

    const releaseCleanup = runActivity.beginCleanup(request.runId);
    if (!releaseCleanup) {
      return errorResponse(
        response,
        409,
        "RUN_BUSY",
        "Run has active requests or cleanup in progress",
      );
    }

    try {
      const activePayment = await PaymentModel.exists({
        runId: request.runId,
        status: { $in: ["processing", "unknown", "refund_pending"] },
      });
      if (activePayment) {
        return errorResponse(
          response,
          409,
          "RUN_BUSY",
          "Run has an unfinished payment or provider operation",
        );
      }

      await ProcessedWebhookModel.deleteMany({ runId: request.runId });
      await PaymentModel.deleteMany({ runId: request.runId });
      await OrderModel.deleteMany({ runId: request.runId });
      await ProductModel.deleteMany({ runId: request.runId });
      return response.status(204).end();
    } catch {
      return errorResponse(
        response,
        503,
        "SERVICE_UNAVAILABLE",
        "Run cleanup is temporarily unavailable",
      );
    } finally {
      releaseCleanup();
    }
  });

  return router;
}


import assert from "node:assert/strict";

const SKU = "SCENARIO-6-PERSISTENCE-SKU";
const IDEMPOTENCY_KEY = "scenario-6-persistence-order-key";

function collectDocuments(collections, predicate) {
  return Object.values(collections).flat().filter(predicate);
}

export async function runRestartPersistence({
  config,
  candidateClient,
  mongoObserver,
  runId,
  restartCandidate,
}) {
  const checks = [];

  function check(name, callback) {
    try {
      callback();
      checks.push({ name, passed: true });
    } catch (error) {
      console.error(`FAILED CHECK: ${name}`);
      throw error;
    }
  }

  const fixture = await candidateClient.request({
    method: "PUT",
    pathname: `/_test/runs/${encodeURIComponent(runId)}/products/${SKU}`,
    runId,
    headers: {
      "X-Benchmark-Test-Secret": config.candidate.testSecret,
    },
    body: {
      name: "Scenario 6 persistence product",
      available: 5,
      unitPriceMinor: 1250,
      currency: "USD",
    },
  });

  check("Persistence product fixture created", () => {
    assert.equal(fixture.status, 201);
    assert.equal(fixture.body.product.sku, SKU);
    assert.equal(fixture.body.product.available, 5);
  });

  const created = await candidateClient.request({
    method: "POST",
    pathname: "/api/orders",
    runId,
    headers: {
      "Idempotency-Key": IDEMPOTENCY_KEY,
    },
    body: {
      sku: SKU,
      quantity: 1,
    },
  });

  check("Order created before restart", () => {
    assert.equal(created.status, 201);
    assert.ok(created.body.order.id);
    assert.ok(created.body.order.payment.id);
    assert.equal(created.body.order.status, "pending_payment");
  });

  const orderId = created.body.order.id;
  const paymentId = created.body.order.payment.id;

  await restartCandidate();

  const publicOrder = await candidateClient.request({
    method: "GET",
    pathname: `/api/orders/${encodeURIComponent(orderId)}`,
    runId,
  });

  check("Public API returns the order after restart", () => {
    assert.equal(publicOrder.status, 200);
    assert.equal(publicOrder.body.order.id, orderId);
    assert.equal(publicOrder.body.order.payment.id, paymentId);
    assert.equal(publicOrder.body.order.status, "pending_payment");
  });

  const observations = await candidateClient.request({
    method: "GET",
    pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
    runId,
    headers: {
      "X-Benchmark-Test-Secret": config.candidate.testSecret,
    },
  });

  check("Normalized observations are available after restart", () => {
    assert.equal(observations.status, 200);
    assert.equal(observations.body.runId, runId);
  });

  const snapshot = observations.body;

  check("Normalized observations preserve order, payment and inventory", () => {
    assert.equal(snapshot.products.length, 1);
    assert.equal(snapshot.products[0].sku, SKU);
    assert.equal(snapshot.products[0].available, 4);

    assert.equal(snapshot.orders.length, 1);
    assert.equal(snapshot.orders[0].idempotencyKey, IDEMPOTENCY_KEY);
    assert.equal(snapshot.orders[0].id, orderId);
    assert.equal(snapshot.orders[0].paymentId, paymentId);

    assert.equal(snapshot.payments.length, 1);
    assert.equal(snapshot.payments[0].orderId, orderId);
  });

  const database = await mongoObserver.getRunDocuments(runId);

  const productDocuments = collectDocuments(
    database,
    (document) => document.sku === SKU && Number.isInteger(document.available),
  );

  const orderDocuments = collectDocuments(
    database,
    (document) => document.idempotencyKey === IDEMPOTENCY_KEY,
  );

  const paymentDocuments = collectDocuments(
    database,
    (document) => document.orderId && document.operationKey,
  );

  check("Independent MongoDB observer confirms persisted product", () => {
    assert.equal(productDocuments.length, 1);
    assert.equal(productDocuments[0].available, 4);
  });

  check("Independent MongoDB observer confirms persisted order", () => {
    assert.equal(orderDocuments.length, 1);
    assert.equal(orderDocuments[0].inventoryDisposition, "held");
  });

  check("Independent MongoDB observer confirms persisted payment", () => {
    assert.equal(paymentDocuments.length, 1);
    assert.equal(paymentDocuments[0].runId, runId);
    assert.equal(paymentDocuments[0].status, snapshot.payments[0].status);
  });

  return {
    scenario: "Persistence After Restart",
    runId,
    passed: true,
    checks,
    evidence: {
      orderId,
      paymentId,
      finalAvailable: productDocuments[0].available,
      mongoOrderCount: orderDocuments.length,
      mongoPaymentCount: paymentDocuments.length,
    },
  };
}

import assert from "node:assert/strict";

const SKU = "SCENARIO-1-SKU";
const IDEMPOTENCY_KEY = "scenario-1-order-key";

function collectDocuments(collections, predicate) {
  return Object.values(collections).flat().filter(predicate);
}

export async function runDuplicateOrderPrevention({
  config,
  candidateClient,
  providerControl,
  mongoObserver,
  runId,
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
      name: "Scenario 1 product",
      available: 5,
      unitPriceMinor: 1250,
      currency: "USD",
    },
  });

  check("Product fixture created", () => {
    assert.equal(fixture.status, 201);
    assert.equal(fixture.body.product.sku, SKU);
    assert.equal(fixture.body.product.available, 5);
  });

  const orderRequest = () =>
    candidateClient.request({
      method: "POST",
      pathname: "/api/orders",
      runId,
      headers: {
        "Idempotency-Key": IDEMPOTENCY_KEY,
      },
      body: {
        sku: SKU,
        quantity: 2,
      },
    });

  // Release both HTTP requests in the same event-loop turn.
  let releaseRequests;
  const startGate = new Promise((resolve) => {
    releaseRequests = resolve;
  });

  const concurrentRequests = [
    startGate.then(orderRequest),
    startGate.then(orderRequest),
  ];

  releaseRequests();

  const responses = await Promise.all(concurrentRequests);

  check("Concurrent requests return 201 and 200", () => {
    assert.deepEqual(
      responses.map((response) => response.status).sort((a, b) => a - b),
      [200, 201],
    );
  });

  const firstOrder = responses[0].body.order;
  const secondOrder = responses[1].body.order;

  check("Both responses identify the same order and payment", () => {
    assert.ok(firstOrder?.id);
    assert.ok(firstOrder?.payment?.id);
    assert.equal(firstOrder.id, secondOrder?.id);
    assert.equal(firstOrder.payment.id, secondOrder?.payment?.id);
    assert.equal(firstOrder.status, "pending_payment");
    assert.equal(firstOrder.inventoryDisposition, "held");
  });

  check("Exactly one response is marked as replay", () => {
    assert.deepEqual(
      responses.map((response) => response.body.replayed).sort(),
      [false, true],
    );
  });

  const orderId = firstOrder.id;

  const replay = await orderRequest();

  check("Exact replay returns 200 and the original identifiers", () => {
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.order.id, orderId);
    assert.equal(replay.body.order.payment.id, firstOrder.payment.id);
  });

  const changedBody = await candidateClient.request({
    method: "POST",
    pathname: "/api/orders",
    runId,
    headers: {
      "Idempotency-Key": IDEMPOTENCY_KEY,
    },
    body: {
      sku: SKU,
      quantity: 3,
    },
  });

  check("Reusing the key with a different body returns 409", () => {
    assert.equal(changedBody.status, 409);
    assert.equal(changedBody.body?.error?.code, "IDEMPOTENCY_KEY_REUSED");
  });

  const publicOrder = await candidateClient.request({
    method: "GET",
    pathname: `/api/orders/${encodeURIComponent(orderId)}`,
    runId,
  });

  check("Public order endpoint returns the persisted order", () => {
    assert.equal(publicOrder.status, 200);
    assert.equal(publicOrder.body.order.id, orderId);
    assert.equal(publicOrder.body.order.payment.id, firstOrder.payment.id);
  });

  const observations = await candidateClient.request({
    method: "GET",
    pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
    runId,
    headers: {
      "X-Benchmark-Test-Secret": config.candidate.testSecret,
    },
  });

  check("Normalized observations endpoint returns 200", () => {
    assert.equal(observations.status, 200);
    assert.equal(observations.body.runId, runId);
  });

  const snapshot = observations.body;

  check("Normalized observations show one order and one payment", () => {
    assert.equal(snapshot.products.length, 1);
    assert.equal(snapshot.products[0].sku, SKU);
    assert.equal(snapshot.products[0].available, 3);

    assert.equal(snapshot.orders.length, 1);
    assert.equal(snapshot.orders[0].idempotencyKey, IDEMPOTENCY_KEY);
    assert.equal(snapshot.orders[0].quantity, 2);
    assert.equal(snapshot.orders[0].paymentId, firstOrder.payment.id);

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
    (document) =>
      document.idempotencyKey === IDEMPOTENCY_KEY && document.paymentId,
  );

  const paymentDocuments = collectDocuments(
    database,
    (document) =>
      document.orderId &&
      document.operationKey &&
      Number.isInteger(document.amountMinor),
  );

  check(
    "Independent MongoDB observer confirms one product with stock 3",
    () => {
      assert.equal(productDocuments.length, 1);
      assert.equal(productDocuments[0].available, 3);
    },
  );

  check("Independent MongoDB observer confirms one order for the key", () => {
    assert.equal(orderDocuments.length, 1);
    assert.equal(orderDocuments[0].inventoryDisposition, "held");
  });

  check("Independent MongoDB observer confirms one payment", () => {
    assert.equal(paymentDocuments.length, 1);
    assert.equal(paymentDocuments[0].runId, runId);
    assert.equal(
      `ord_${paymentDocuments[0].orderId}`,
      snapshot.payments[0].orderId,
    );
    assert.equal(
      paymentDocuments[0].operationKey,
      snapshot.payments[0].operationKey,
    );
    assert.equal(
      paymentDocuments[0].amountMinor,
      snapshot.payments[0].amountMinor,
    );
    assert.equal(paymentDocuments[0].status, snapshot.payments[0].status);
  });

  const ledger = await providerControl.getLedger(runId);

  check("No provider charge was created during order creation", () => {
    assert.equal(ledger.operations.length, 0);
    assert.equal(ledger.captures.length, 0);
    assert.equal(ledger.refunds.length, 0);
  });

  return {
    scenario: "Duplicate Order Prevention",
    runId,
    passed: true,
    checks,
    evidence: {
      concurrentHttpStatuses: responses.map((response) => response.status),
      orderId,
      paymentId: firstOrder.payment.id,
      finalAvailable: productDocuments[0].available,
      mongoOrderCount: orderDocuments.length,
      mongoPaymentCount: paymentDocuments.length,
      providerOperationCount: ledger.operations.length,
    },
  };
}

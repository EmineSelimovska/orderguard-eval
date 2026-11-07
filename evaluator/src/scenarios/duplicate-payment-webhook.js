import assert from "node:assert/strict";

const SKU = "SCENARIO-3-WEBHOOK-SKU";
const IDEMPOTENCY_KEY = "scenario-3-order-key";
const EVENT_ID = "scenario-3-payment-success-event";

export async function runDuplicatePaymentWebhook({
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
      name: "Scenario 3 webhook product",
      available: 2,
      unitPriceMinor: 3200,
      currency: "USD",
    },
  });

  check("Product fixture created", () => {
    assert.equal(fixture.status, 201);
    assert.equal(fixture.body.product.sku, SKU);
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

  check("Order created successfully", () => {
    assert.equal(created.status, 201);
    assert.ok(created.body.order?.id);
    assert.ok(created.body.order?.payment?.id);
  });

  const orderId = created.body.order.id;
  const paymentId = created.body.order.payment.id;

  const observations = await candidateClient.request({
    method: "GET",
    pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
    runId,
    headers: {
      "X-Benchmark-Test-Secret": config.candidate.testSecret,
    },
  });

  check("Payment observations are available", () => {
    assert.equal(observations.status, 200);
    assert.equal(observations.body.payments.length, 1);
  });

  const payment = observations.body.payments[0];

  check("Payment identifiers and amount are valid", () => {
    assert.equal(payment.id, paymentId);
    assert.ok(payment.operationKey);
    assert.ok(Number.isSafeInteger(payment.amountMinor));
    assert.ok(["USD", "EUR", "GBP"].includes(payment.currency));
  });

  await providerControl.configureOperation(runId, payment.operationKey, {
    chargeOutcome: "success",
    holdAt: null,
  });

  const attempt = await candidateClient.request({
    method: "POST",
    pathname: `/api/orders/${encodeURIComponent(orderId)}/payment-attempts`,
    runId,
  });

  check("Payment attempt succeeds", () => {
    assert.equal(attempt.status, 200);
  });

  const webhookPayload = {
    eventId: EVENT_ID,
    type: "payment.succeeded",
    paymentId,
    operationKey: payment.operationKey,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
  };

  const sendWebhook = (body) =>
    candidateClient.request({
      method: "POST",
      pathname: '/api/webhooks/payments',
      runId,
      body,
    });

  const firstWebhook = await sendWebhook(webhookPayload);

  check("Matching pre-applied success webhook is accepted", () => {
    assert.equal(firstWebhook.status, 200);
    assert.equal(firstWebhook.body.eventId, EVENT_ID);
    assert.equal(firstWebhook.body.processingResult, "applied");
    assert.equal(firstWebhook.body.duplicate, false);
  });

  const replay = await sendWebhook(webhookPayload);

  check("Sequential duplicate webhook is idempotent", () => {
    assert.equal(replay.status, 200);
    assert.equal(replay.body.eventId, EVENT_ID);
    assert.equal(replay.body.duplicate, true);
  });

  let releaseRequests;
  const startGate = new Promise((resolve) => {
    releaseRequests = resolve;
  });

  const concurrentResponses = [
    startGate.then(() => sendWebhook(webhookPayload)),
    startGate.then(() => sendWebhook(webhookPayload)),
  ];

  releaseRequests();

  const concurrentResults = await Promise.all(concurrentResponses);

  check("Concurrent duplicate webhooks are accepted", () => {
    assert.deepEqual(
      concurrentResults.map((response) => response.status),
      [200, 200],
    );
    assert.ok(
      concurrentResults.every((response) => response.body.duplicate === true),
    );
  });

  const alteredPayload = {
    ...webhookPayload,
    amountMinor: webhookPayload.amountMinor + 1,
  };

  const conflict = await sendWebhook(alteredPayload);

  check("Same event ID with a different payload returns 409", () => {
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body?.error?.code, "EVENT_ID_PAYLOAD_CONFLICT");
  });

  const finalObservations = await candidateClient.request({
    method: "GET",
    pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
    runId,
    headers: {
      "X-Benchmark-Test-Secret": config.candidate.testSecret,
    },
  });

  check("Final normalized observations are available", () => {
    assert.equal(finalObservations.status, 200);
    assert.equal(finalObservations.body.orders.length, 1);
    assert.equal(finalObservations.body.payments.length, 1);
  });

  const finalOrder = finalObservations.body.orders[0];
  const finalPayment = finalObservations.body.payments[0];

  check("Webhook duplicates did not create extra order/payment effects", () => {
    assert.equal(finalOrder.id, orderId);
    assert.equal(finalPayment.id, paymentId);
    assert.equal(finalPayment.status, "succeeded");
  });

  const database = await mongoObserver.getRunDocuments(runId);
  const documents = Object.values(database).flat();

  const webhookDocuments = documents.filter(
    (document) => document.eventId === EVENT_ID,
  );

  check("Independent MongoDB observer confirms one processed webhook", () => {
    assert.equal(webhookDocuments.length, 1);
  });

  const ledger = await providerControl.getLedger(runId);

  check("Provider ledger confirms exactly one successful capture", () => {
    assert.equal(ledger.captures.length, 1);
    assert.equal(ledger.refunds.length, 0);
  });

  return {
    scenario: "Duplicate Payment Webhook",
    runId,
    passed: true,
    checks,
    evidence: {
      orderId,
      paymentId,
      webhookEventId: EVENT_ID,
      sequentialReplayStatus: replay.status,
      concurrentWebhookStatuses: concurrentResults.map(
        (response) => response.status,
      ),
      alteredPayloadStatus: conflict.status,
      mongoWebhookCount: webhookDocuments.length,
      providerCaptureCount: ledger.captures.length,
    },
  };
}

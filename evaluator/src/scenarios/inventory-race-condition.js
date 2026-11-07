
import assert from 'node:assert/strict';

const SKU = 'SCENARIO-2-RACE-SKU';
const IDEMPOTENCY_KEYS = [
  'scenario-2-order-key-a',
  'scenario-2-order-key-b',
];

function collectDocuments(collections, predicate) {
  return Object.values(collections).flat().filter(predicate);
}

export async function runInventoryRaceCondition({
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
    method: 'PUT',
    pathname: `/_test/runs/${encodeURIComponent(runId)}/products/${SKU}`,
    runId,
    headers: {
      'X-Benchmark-Test-Secret': config.candidate.testSecret,
    },
    body: {
      name: 'Scenario 2 race product',
      available: 1,
      unitPriceMinor: 2500,
      currency: 'USD',
    },
  });

  check('Product fixture created with one available unit', () => {
    assert.equal(fixture.status, 201);
    assert.equal(fixture.body.product.sku, SKU);
    assert.equal(fixture.body.product.available, 1);
  });

  const orderRequest = (idempotencyKey) => candidateClient.request({
    method: 'POST',
    pathname: '/api/orders',
    runId,
    headers: {
      'Idempotency-Key': idempotencyKey,
    },
    body: {
      sku: SKU,
      quantity: 1,
    },
  });

  // Start both independent order requests in the same event-loop turn.
  let releaseRequests;
  const startGate = new Promise((resolve) => {
    releaseRequests = resolve;
  });

  const concurrentRequests = IDEMPOTENCY_KEYS.map((key) =>
    startGate.then(() => orderRequest(key)),
  );

  releaseRequests();

  const responses = await Promise.all(concurrentRequests);

  check('Exactly one order succeeds and one conflicts', () => {
    assert.deepEqual(
      responses.map((response) => response.status).sort((a, b) => a - b),
      [201, 409],
    );

    const conflict = responses.find((response) => response.status === 409);
    assert.equal(
      conflict.body?.error?.code,
      'INSUFFICIENT_INVENTORY',
    );
  });

  const successfulResponse = responses.find(
    (response) => response.status === 201,
  );

  const successfulOrder = successfulResponse.body.order;

  check('The successful request created one pending order', () => {
    assert.ok(successfulOrder?.id);
    assert.ok(successfulOrder?.payment?.id);
    assert.equal(successfulOrder.status, 'pending_payment');
    assert.equal(successfulOrder.inventoryDisposition, 'held');
  });

  const observations = await candidateClient.request({
    method: 'GET',
    pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
    runId,
    headers: {
      'X-Benchmark-Test-Secret': config.candidate.testSecret,
    },
  });

  check('Normalized observations endpoint returns 200', () => {
    assert.equal(observations.status, 200);
    assert.equal(observations.body.runId, runId);
  });

  const snapshot = observations.body;

  check('Normalized observations show stock zero and one order/payment', () => {
    assert.equal(snapshot.products.length, 1);
    assert.equal(snapshot.products[0].sku, SKU);
    assert.equal(snapshot.products[0].available, 0);

    assert.equal(snapshot.orders.length, 1);
    assert.ok(
      IDEMPOTENCY_KEYS.includes(snapshot.orders[0].idempotencyKey),
    );
    assert.equal(snapshot.orders[0].quantity, 1);
    assert.equal(snapshot.orders[0].paymentId, successfulOrder.payment.id);
    assert.equal(snapshot.orders[0].inventoryDisposition, 'held');

    assert.equal(snapshot.payments.length, 1);
    assert.equal(snapshot.payments[0].id, successfulOrder.payment.id);
    assert.equal(snapshot.payments[0].orderId, successfulOrder.id);
  });

  const database = await mongoObserver.getRunDocuments(runId);

  const productDocuments = collectDocuments(
    database,
    (document) => document.sku === SKU
      && Number.isInteger(document.available),
  );

  const orderDocuments = collectDocuments(
    database,
    (document) => IDEMPOTENCY_KEYS.includes(document.idempotencyKey),
  );

  const paymentDocuments = collectDocuments(
    database,
    (document) => document.runId === runId
      && document.orderId
      && document.operationKey
      && Number.isInteger(document.amountMinor),
  );

  check('Independent MongoDB observer confirms stock is zero', () => {
    assert.equal(productDocuments.length, 1);
    assert.equal(productDocuments[0].available, 0);
  });

  check('Independent MongoDB observer confirms exactly one order', () => {
    assert.equal(orderDocuments.length, 1);
    assert.ok(
      IDEMPOTENCY_KEYS.includes(orderDocuments[0].idempotencyKey),
    );
    assert.equal(orderDocuments[0].inventoryDisposition, 'held');
  });

  check('Independent MongoDB observer confirms exactly one payment', () => {
    assert.equal(paymentDocuments.length, 1);
    assert.equal(
      paymentDocuments[0].orderId,
      orderDocuments[0]._id.toString(),
    );
    assert.equal(paymentDocuments[0].status, 'pending');
  });

  const ledger = await providerControl.getLedger(runId);

  check('No provider charge was created during order creation', () => {
    assert.equal(ledger.operations.length, 0);
    assert.equal(ledger.captures.length, 0);
    assert.equal(ledger.refunds.length, 0);
  });

  return {
    scenario: 'Inventory Race Condition',
    runId,
    passed: true,
    checks,
    evidence: {
      concurrentHttpStatuses: responses.map((response) => response.status),
      successfulOrderId: successfulOrder.id,
      successfulPaymentId: successfulOrder.payment.id,
      finalAvailable: productDocuments[0].available,
      mongoOrderCount: orderDocuments.length,
      mongoPaymentCount: paymentDocuments.length,
      providerOperationCount: ledger.operations.length,
    },
  };
}

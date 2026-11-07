
import assert from 'node:assert/strict';

const SKU = 'SCENARIO-4-TIMEOUT-SKU';

const CASES = [
  {
    name: 'Timeout before processing',
    idempotencyKey: 'scenario-4-before-processing',
    chargeOutcome: 'timeout_before_processing',
    expectedTimeoutStatus: 'pending',
    expectedLastSafeOutcome: 'not_processed',
  },
  {
    name: 'Processed response timeout',
    idempotencyKey: 'scenario-4-after-processing',
    chargeOutcome: 'processed_response_timeout',
    expectedTimeoutStatus: 'unknown',
    expectedLastSafeOutcome: 'unknown',
  },
];

export async function runPaymentTimeoutRetry({
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
      name: 'Scenario 4 timeout product',
      available: 2,
      unitPriceMinor: 4500,
      currency: 'USD',
    },
  });

  check('Product fixture created with two units', () => {
    assert.equal(fixture.status, 201);
    assert.equal(fixture.body.product.available, 2);
  });

  const results = [];

  for (const testCase of CASES) {
    const created = await candidateClient.request({
      method: 'POST',
      pathname: '/api/orders',
      runId,
      headers: {
        'Idempotency-Key': testCase.idempotencyKey,
      },
      body: {
        sku: SKU,
        quantity: 1,
      },
    });

    check(`${testCase.name}: order created`, () => {
      assert.equal(created.status, 201);
      assert.ok(created.body.order?.id);
      assert.ok(created.body.order?.payment?.id);
    });

    const orderId = created.body.order.id;
    const paymentId = created.body.order.payment.id;

    const observations = await candidateClient.request({
      method: 'GET',
      pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
      runId,
      headers: {
        'X-Benchmark-Test-Secret': config.candidate.testSecret,
      },
    });

    check(`${testCase.name}: payment observation available`, () => {
      assert.equal(observations.status, 200);
    });

    const payment = observations.body.payments.find(
      (item) => item.id === paymentId,
    );

    check(`${testCase.name}: payment has a stable operation key`, () => {
      assert.ok(payment);
      assert.ok(payment.operationKey);
      assert.equal(payment.status, 'pending');
    });

    const operationKey = payment.operationKey;

    await providerControl.configureOperation(
      runId,
      operationKey,
      {
        chargeOutcome: testCase.chargeOutcome,
        holdAt: null,
      },
    );

    const attempt = () => candidateClient.request({
      method: 'POST',
      pathname: `/api/orders/${encodeURIComponent(orderId)}/payment-attempts`,
      runId,
    });

    const firstAttempt = await attempt();

    check(`${testCase.name}: first attempt returns HTTP 504`, () => {
      assert.equal(firstAttempt.status, 504);
    });

    const afterTimeout = await candidateClient.request({
      method: 'GET',
      pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
      runId,
      headers: {
        'X-Benchmark-Test-Secret': config.candidate.testSecret,
      },
    });

    const paymentAfterTimeout = afterTimeout.body.payments.find(
      (item) => item.id === paymentId,
    );

    check(`${testCase.name}: timeout state is persisted correctly`, () => {
      assert.equal(afterTimeout.status, 200);
      assert.equal(
        paymentAfterTimeout.status,
        testCase.expectedTimeoutStatus,
      );
    });

    const retry = await attempt();

    check(`${testCase.name}: retry succeeds with HTTP 200`, () => {
      assert.equal(retry.status, 200);
    });

    const afterRetry = await candidateClient.request({
      method: 'GET',
      pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
      runId,
      headers: {
        'X-Benchmark-Test-Secret': config.candidate.testSecret,
      },
    });

    const finalPayment = afterRetry.body.payments.find(
      (item) => item.id === paymentId,
    );

    const finalOrder = afterRetry.body.orders.find(
      (item) => item.id === orderId,
    );

    check(`${testCase.name}: retry completes the payment and order`, () => {
      assert.equal(afterRetry.status, 200);
      assert.equal(finalPayment.status, 'succeeded');
      assert.equal(finalOrder.status, 'paid');
    });

    check(`${testCase.name}: operation key remains unchanged`, () => {
      assert.equal(finalPayment.operationKey, operationKey);
    });

    results.push({
      name: testCase.name,
      orderId,
      paymentId,
      operationKey,
      firstAttemptStatus: firstAttempt.status,
      timeoutPaymentStatus: paymentAfterTimeout.status,
      retryStatus: retry.status,
      finalPaymentStatus: finalPayment.status,
      finalOrderStatus: finalOrder.status,
    });
  }

  const database = await mongoObserver.getRunDocuments(runId);
  const documents = Object.values(database).flat();

  const paymentDocuments = documents.filter(
    (document) => results.some(
      (result) => result.operationKey === document.operationKey,
    ),
  );

  check('Independent MongoDB observer confirms two payment records', () => {
    assert.equal(paymentDocuments.length, 2);

    for (const result of results) {
      const payment = paymentDocuments.find(
        (item) => item.operationKey === result.operationKey,
      );

      assert.ok(payment);
      assert.equal(payment.status, 'succeeded');
      assert.equal(payment.lastSafeOutcome, 'succeeded');
      assert.equal(payment.attemptCount, 2);
    }
  });

  const ledger = await providerControl.getLedger(runId);

  check('Provider ledger confirms exactly two charge operations', () => {
    assert.equal(ledger.operations.length, 2);
  });

  check('Provider ledger confirms exactly two successful captures', () => {
    assert.equal(ledger.captures.length, 2);
    assert.equal(ledger.refunds.length, 0);

    for (const result of results) {
      const captures = ledger.captures.filter(
        (capture) => capture.operationKey === result.operationKey,
      );
      assert.equal(captures.length, 1);
    }
  });

  return {
    scenario: 'Payment Timeout & Retry',
    runId,
    passed: true,
    checks,
    evidence: {
      cases: results,
      mongoPaymentCount: paymentDocuments.length,
      providerOperationCount: ledger.operations.length,
      providerCaptureCount: ledger.captures.length,
    },
  };
}

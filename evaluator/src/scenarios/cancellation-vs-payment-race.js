
import assert from "node:assert/strict";

const SKU = "SCENARIO-5-CANCELLATION-RACE-SKU";

export async function runCancellationVsPaymentRace({
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

  async function createOrder(idempotencyKey) {
    const response = await candidateClient.request({
      method: "POST",
      pathname: "/api/orders",
      runId,
      headers: { "Idempotency-Key": idempotencyKey },
      body: { sku: SKU, quantity: 1 },
    });

    assert.equal(response.status, 201);
    return {
      orderId: response.body.order.id,
      paymentId: response.body.order.payment.id,
    };
  }

  async function getObservations() {
    const response = await candidateClient.request({
      pathname: `/_test/runs/${encodeURIComponent(runId)}/observations`,
      runId,
      headers: {
        "X-Benchmark-Test-Secret": config.candidate.testSecret,
      },
    });

    assert.equal(response.status, 200);
    return response.body;
  }

  async function cancelOrder(orderId) {
    return candidateClient.request({
      method: "POST",
      pathname: `/api/orders/${encodeURIComponent(orderId)}/cancel`,
      runId,
    });
  }

  async function sendWebhook(payload) {
    return candidateClient.request({
      method: "POST",
      pathname: "/api/webhooks/payments",
      runId,
      body: payload,
    });
  }

  // One fixture is shared by the three independent order cases.
  const fixture = await candidateClient.request({
    method: "PUT",
    pathname: `/_test/runs/${encodeURIComponent(runId)}/products/${SKU}`,
    runId,
    headers: {
      "X-Benchmark-Test-Secret": config.candidate.testSecret,
    },
    body: {
      name: "Scenario 5 cancellation race product",
      available: 3,
      unitPriceMinor: 4500,
      currency: "USD",
    },
  });

  check("Product fixture created", () => {
    assert.equal(fixture.status, 201);
    assert.equal(fixture.body.product.sku, SKU);
  });

  // Case 1: payment completes before cancellation.
  const paymentFirst = await createOrder("scenario-5-payment-first");

  let observations = await getObservations();
  let paymentFirstRecord = observations.payments.find(
    (payment) => payment.id === paymentFirst.paymentId,
  );

  check("Payment-first identifiers are available", () => {
    assert.ok(paymentFirstRecord);
    assert.ok(paymentFirstRecord.operationKey);
  });

  await providerControl.configureOperation(
    runId,
    paymentFirstRecord.operationKey,
    { chargeOutcome: "success", holdAt: null },
  );

  const successfulAttempt = await candidateClient.request({
    method: "POST",
    pathname: `/api/orders/${encodeURIComponent(paymentFirst.orderId)}/payment-attempts`,
    runId,
  });

  check("Payment-first charge succeeds", () => {
    assert.equal(successfulAttempt.status, 200);
  });

  const cancelPaidOrder = await cancelOrder(paymentFirst.orderId);

  check("Cancellation after successful payment is rejected", () => {
    assert.equal(cancelPaidOrder.status, 409);
    assert.equal(
      cancelPaidOrder.body?.error?.code,
      "ORDER_ALREADY_PAID",
    );
  });

  observations = await getObservations();
  const paidOrder = observations.orders.find(
    (order) => order.id === paymentFirst.orderId,
  );
  const paidPayment = observations.payments.find(
    (payment) => payment.id === paymentFirst.paymentId,
  );

  check("Payment-first state remains paid and succeeded", () => {
    assert.equal(paidOrder?.status, "paid");
    assert.equal(paidPayment?.status, "succeeded");
  });

  // Case 2: cancellation completes before any payment attempt.
  const cancellationFirst = await createOrder(
    "scenario-5-cancellation-first",
  );

  const cancelled = await cancelOrder(cancellationFirst.orderId);

  check("Cancellation-first request succeeds", () => {
    assert.equal(cancelled.status, 200);
  });

  const paymentAfterCancellation = await candidateClient.request({
    method: "POST",
    pathname: `/api/orders/${encodeURIComponent(cancellationFirst.orderId)}/payment-attempts`,
    runId,
  });

  check("Payment attempt after cancellation is rejected", () => {
    assert.equal(paymentAfterCancellation.status, 409);
  });

  observations = await getObservations();
  const cancelledOrder = observations.orders.find(
    (order) => order.id === cancellationFirst.orderId,
  );
  const voidedPayment = observations.payments.find(
    (payment) => payment.id === cancellationFirst.paymentId,
  );

  check("Cancellation-first state is cancelled and voided", () => {
    assert.equal(cancelledOrder?.status, "cancelled");
    assert.equal(cancelledOrder?.inventoryDisposition, "released");
    assert.equal(voidedPayment?.status, "voided");
  });

  check("Cancellation-first did not call the Provider", async () => {
    // The Provider ledger is checked below with the final ledger.
    assert.ok(voidedPayment?.operationKey);
  });

  // Case 3: Provider captures after the order has already been cancelled.
  const lateSuccess = await createOrder("scenario-5-late-success");

  observations = await getObservations();
  const latePayment = observations.payments.find(
    (payment) => payment.id === lateSuccess.paymentId,
  );

  check("Late-success payment details are available", () => {
    assert.ok(latePayment);
    assert.ok(latePayment.operationKey);
    assert.ok(Number.isSafeInteger(latePayment.amountMinor));
    assert.ok(["USD", "EUR", "GBP"].includes(latePayment.currency));
  });

  await providerControl.configureOperation(
    runId,
    latePayment.operationKey,
    {
      chargeOutcome: "success",
      holdAt: "before_processing",
    },
  );

  // Start the Provider request without awaiting it: it will block at the gate.
  const chargePromise = fetch(
    `http://127.0.0.1:${config.provider.port}/v1/charges`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.provider.clientToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId,
        operationKey: latePayment.operationKey,
        amountMinor: latePayment.amountMinor,
        currency: latePayment.currency,
      }),
      signal: AbortSignal.timeout(30000),
    },
  ).then(async (response) => ({
    status: response.status,
    body: await response.json(),
  }));

  // Wait for the explicit Provider ledger signal that the gate is held.
  const deadline = Date.now() + 10000;
  let gateHeld = false;

  while (Date.now() < deadline) {
    const ledger = await providerControl.getLedger(runId);
    const operation = ledger.operations.find(
      (item) => item.operationKey === latePayment.operationKey,
    );

    if (operation?.waitingAt === "before_processing") {
      gateHeld = true;
      break;
    }

    if (operation && operation.status !== "processing") {
      throw new Error(
        `Provider operation entered unexpected state: ${operation.status}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  check("Provider charge is held before processing", () => {
    assert.equal(gateHeld, true);
  });

  const cancelBeforeCapture = await cancelOrder(lateSuccess.orderId);

  check("Order is cancelled while Provider charge is held", () => {
    assert.equal(cancelBeforeCapture.status, 200);
  });

  observations = await getObservations();
  const cancelledLateOrder = observations.orders.find(
    (order) => order.id === lateSuccess.orderId,
  );
  const voidedLatePayment = observations.payments.find(
    (payment) => payment.id === lateSuccess.paymentId,
  );

  check("Late-success order is cancelled before capture", () => {
    assert.equal(cancelledLateOrder?.status, "cancelled");
    assert.equal(cancelledLateOrder?.inventoryDisposition, "released");
    assert.equal(voidedLatePayment?.status, "voided");
  });

  await providerControl.releaseOperation(
    runId,
    latePayment.operationKey,
    "before_processing",
  );

  const chargeResult = await chargePromise;

  check("Held Provider charge completes successfully", () => {
    assert.equal(chargeResult.status, 200);
    assert.equal(chargeResult.body.status, "succeeded");
    assert.equal(
      chargeResult.body.operationKey,
      latePayment.operationKey,
    );
  });

  const webhookPayload = {
    eventId: "scenario-5-late-payment-success-event",
    type: "payment.succeeded",
    paymentId: lateSuccess.paymentId,
    operationKey: latePayment.operationKey,
    amountMinor: latePayment.amountMinor,
    currency: latePayment.currency,
  };

  const lateWebhook = await sendWebhook(webhookPayload);

  check("Late success webhook triggers completed refund", () => {
    assert.equal(lateWebhook.status, 200);
    assert.equal(
      lateWebhook.body.processingResult,
      "refund_completed",
    );
    assert.equal(lateWebhook.body.duplicate, false);
  });

  const webhookReplay = await sendWebhook(webhookPayload);

  check("Repeated late-success webhook is idempotent", () => {
    assert.equal(webhookReplay.status, 200);
    assert.equal(webhookReplay.body.duplicate, true);
    assert.equal(
      webhookReplay.body.processingResult,
      "refund_completed",
    );
  });

  // Verify all three final order/payment states.
  observations = await getObservations();

  const finalPaidOrder = observations.orders.find(
    (order) => order.id === paymentFirst.orderId,
  );
  const finalCancelledOrder = observations.orders.find(
    (order) => order.id === cancellationFirst.orderId,
  );
  const finalRefundedOrder = observations.orders.find(
    (order) => order.id === lateSuccess.orderId,
  );

  const finalPaidPayment = observations.payments.find(
    (payment) => payment.id === paymentFirst.paymentId,
  );
  const finalVoidedPayment = observations.payments.find(
    (payment) => payment.id === cancellationFirst.paymentId,
  );
  const finalRefundedPayment = observations.payments.find(
    (payment) => payment.id === lateSuccess.paymentId,
  );

  check("All three final order states are coherent", () => {
    assert.equal(finalPaidOrder?.status, "paid");
    assert.equal(finalCancelledOrder?.status, "cancelled");
    assert.equal(finalRefundedOrder?.status, "cancelled");
  });

 check("All three final payment states are coherent", () => {
  assert.equal(finalPaidPayment?.status, "succeeded");
  assert.equal(finalVoidedPayment?.status, "voided");
  assert.equal(finalRefundedPayment?.status, "refunded");
  assert.ok(finalRefundedPayment?.refundOperationKey);
  assert.equal(
    finalRefundedPayment.refundOperationKey,
    `refund_${latePayment.operationKey}`,
  );
});

  check("Late-success inventory remains released", () => {
    assert.equal(finalRefundedOrder?.inventoryDisposition, "released");
  });

  // Independent MongoDB evidence.
  const database = await mongoObserver.getRunDocuments(runId);
  const documents = Object.values(database).flat();

  const webhookDocuments = documents.filter(
    (document) => document.eventId === webhookPayload.eventId,
  );

  check("MongoDB confirms exactly one late-success webhook record", () => {
    assert.equal(webhookDocuments.length, 1);
    assert.equal(
      webhookDocuments[0].processingResult,
      "refund_completed",
    );
  });

  // Independent Provider ledger evidence.
  const ledger = await providerControl.getLedger(runId);

  check("Provider ledger confirms exactly two captures", () => {
    assert.equal(ledger.captures.length, 2);
    assert.ok(
      ledger.captures.some(
        (capture) => capture.operationKey === paymentFirstRecord.operationKey,
      ),
    );
    assert.ok(
      ledger.captures.some(
        (capture) => capture.operationKey === latePayment.operationKey,
      ),
    );
  });

  check("Provider ledger confirms exactly one refund", () => {
    assert.equal(ledger.refunds.length, 1);
    assert.equal(
      ledger.refunds[0].originalOperationKey,
      latePayment.operationKey,
    );
    assert.equal(
      ledger.refunds[0].refundOperationKey,
      `refund_${latePayment.operationKey}`,
    );
    assert.equal(ledger.pendingRefunds.length, 0);
  });

  check("Cancellation-first produced no Provider charge", () => {
    assert.equal(
      ledger.operations.some(
        (operation) => operation.operationKey === voidedPayment.operationKey,
      ),
      false,
    );
  });

  return {
    scenario: "Cancellation vs Payment Race",
    runId,
    passed: true,
    checks,
    evidence: {
      paymentFirstOrderId: paymentFirst.orderId,
      cancellationFirstOrderId: cancellationFirst.orderId,
      lateSuccessOrderId: lateSuccess.orderId,
      lateWebhookEventId: webhookPayload.eventId,
      lateWebhookReplayStatus: webhookReplay.status,
      captureCount: ledger.captures.length,
      refundCount: ledger.refunds.length,
      mongoWebhookCount: webhookDocuments.length,
    },
  };
}

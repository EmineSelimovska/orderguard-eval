import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createProviderApp } from '../src/app.js';
import { createMockProvider } from '../src/provider.js';

const CLIENT = 'test-client-token';
const ADMIN = 'test-admin-token';

async function withServer(run) {
  const provider = createMockProvider();
  const server = createProviderApp({
    clientToken: CLIENT,
    adminToken: ADMIN,
    provider,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await run({ baseUrl, provider });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function call(baseUrl, path, {
  token = CLIENT,
  method = 'POST',
  body,
} = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function eventually(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected provider state was not reached');
}

async function plan(baseUrl, runId, operationKey, body) {
  return call(
    baseUrl,
    `/_control/v1/runs/${runId}/operations/${operationKey}`,
    { token: ADMIN, method: 'PUT', body },
  );
}

async function ledger(baseUrl, runId) {
  const response = await call(
    baseUrl,
    `/_control/v1/runs/${runId}/ledger`,
    { token: ADMIN, method: 'GET' },
  );
  return response.json();
}

test('isolates data-plane and admin credentials', async () => {
  await withServer(async ({ baseUrl }) => {
    const missing = await fetch(`${baseUrl}/v1/charges`, { method: 'POST' });
    assert.equal(missing.status, 401);

    const deniedPlan = await call(
      baseUrl,
      '/_control/v1/runs/run-a/operations/op-a',
      {
        token: CLIENT,
        method: 'PUT',
        body: { chargeOutcome: 'success', holdAt: null },
      },
    );
    assert.equal(deniedPlan.status, 403);

    const deniedCharge = await call(baseUrl, '/v1/charges', {
      token: ADMIN,
      body: { runId: 'run-a', operationKey: 'op-a', amountMinor: 100, currency: 'USD' },
    });
    assert.equal(deniedCharge.status, 403);

    const deniedLedger = await call(
      baseUrl,
      '/_control/v1/runs/run-a/ledger',
      { token: CLIENT, method: 'GET' },
    );
    assert.equal(deniedLedger.status, 403);

    const deniedCleanup = await call(
      baseUrl,
      '/_control/v1/runs/run-a',
      { token: CLIENT, method: 'DELETE' },
    );
    assert.equal(deniedCleanup.status, 403);
  });
});

test('charges are run-scoped and idempotent, with payload conflicts rejected', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await call(baseUrl, '/v1/charges', {
      body: { runId: 'run-a', operationKey: 'op-a', amountMinor: 1250, currency: 'USD' },
    });
    assert.equal(first.status, 200);
    const original = await first.json();

    const replay = await call(baseUrl, '/v1/charges', {
      body: { runId: 'run-a', operationKey: 'op-a', amountMinor: 1250, currency: 'USD' },
    });
    assert.deepEqual(await replay.json(), original);

    const conflict = await call(baseUrl, '/v1/charges', {
      body: { runId: 'run-a', operationKey: 'op-a', amountMinor: 1251, currency: 'USD' },
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');

    const runB = await call(baseUrl, '/v1/charges', {
      body: { runId: 'run-b', operationKey: 'op-a', amountMinor: 1250, currency: 'USD' },
    });
    assert.equal(runB.status, 200);
    assert.notEqual((await runB.json()).providerReference, original.providerReference);
    assert.equal((await ledger(baseUrl, 'run-a')).captures.length, 1);
    assert.equal((await ledger(baseUrl, 'run-b')).captures.length, 1);
  });
});

test('timeout before processing is retryable with the same operation key', async () => {
  await withServer(async ({ baseUrl }) => {
    const configured = await plan(baseUrl, 'run-timeout', 'op-timeout', {
      chargeOutcome: 'timeout_before_processing',
      holdAt: null,
    });
    assert.equal(configured.status, 201);

    const first = await call(baseUrl, '/v1/charges', {
      body: { runId: 'run-timeout', operationKey: 'op-timeout', amountMinor: 800, currency: 'EUR' },
    });
    assert.equal(first.status, 504);
    assert.deepEqual(await first.json(), {
      code: 'NOT_PROCESSED',
      runId: 'run-timeout',
      operationKey: 'op-timeout',
    });
    assert.equal((await ledger(baseUrl, 'run-timeout')).captures.length, 0);

    const retry = await call(baseUrl, '/v1/charges', {
      body: { runId: 'run-timeout', operationKey: 'op-timeout', amountMinor: 800, currency: 'EUR' },
    });
    assert.equal(retry.status, 200);
    assert.equal((await ledger(baseUrl, 'run-timeout')).captures.length, 1);
  });
});

test('a captured response timeout loses transport but preserves the idempotent result', async () => {
  await withServer(async ({ baseUrl }) => {
    await plan(baseUrl, 'run-lost', 'op-lost', {
      chargeOutcome: 'processed_response_timeout',
      holdAt: null,
    });
    await assert.rejects(call(baseUrl, '/v1/charges', {
      body: { runId: 'run-lost', operationKey: 'op-lost', amountMinor: 900, currency: 'GBP' },
    }));
    assert.equal((await ledger(baseUrl, 'run-lost')).captures.length, 1);

    const retry = await call(baseUrl, '/v1/charges', {
      body: { runId: 'run-lost', operationKey: 'op-lost', amountMinor: 900, currency: 'GBP' },
    });
    assert.equal(retry.status, 200);
    assert.equal((await ledger(baseUrl, 'run-lost')).captures.length, 1);
  });
});

test('charge gates expose pre-processing and durable-capture stages', async () => {
  const provider = createMockProvider();
  provider.configureOperation('run-gate', 'op-before', {
    chargeOutcome: 'success',
    holdAt: 'before_processing',
  });
  const before = provider.charge('run-gate', 'op-before', 100, 'USD');
  await eventually(() => provider.getLedger('run-gate').operations
    .some((operation) => operation.waitingAt === 'before_processing'));
  assert.equal(provider.getLedger('run-gate').captures.length, 0);
  provider.releaseOperationGate('run-gate', 'op-before', 'before_processing');
  assert.equal((await before).status, 'succeeded');

  provider.configureOperation('run-gate', 'op-after', {
    chargeOutcome: 'success',
    holdAt: 'after_capture_before_response',
  });
  const after = provider.charge('run-gate', 'op-after', 100, 'USD');
  await eventually(() => provider.getLedger('run-gate').operations
    .some((operation) => operation.operationKey === 'op-after'
      && operation.waitingAt === 'after_capture_before_response'));
  assert.equal(provider.getLedger('run-gate').captures.length, 2);
  provider.releaseOperationGate('run-gate', 'op-after', 'after_capture_before_response');
  assert.equal((await after).status, 'succeeded');
});

test('refund response-loss gate returns the original refund on same-key retry', async () => {
  await withServer(async ({ baseUrl }) => {
    const configured = await plan(baseUrl, 'run-refund', 'op-refund', {
      chargeOutcome: 'success',
      holdAt: null,
      refundOutcome: 'processed_response_timeout',
      refundHoldAt: 'after_refund_before_response',
    });
    assert.equal(configured.status, 201);
    const charge = await call(baseUrl, '/v1/charges', {
      body: { runId: 'run-refund', operationKey: 'op-refund', amountMinor: 500, currency: 'USD' },
    });
    assert.equal(charge.status, 200);

    const refundPath = '/v1/refunds';
    const refundBody = {
      runId: 'run-refund',
      refundOperationKey: 'refund-op-refund',
      originalOperationKey: 'op-refund',
    };
    const firstRefund = call(baseUrl, refundPath, { body: refundBody });
    await eventually(async () => {
      const state = await ledger(baseUrl, 'run-refund');
      return state.refunds.some((refund) => (
        refund.status === 'refunded'
        && refund.waitingAt === 'after_refund_before_response'
      ));
    });

    const released = await call(
      baseUrl,
      '/_control/v1/runs/run-refund/operations/op-refund/release',
      { token: ADMIN, body: { phase: 'after_refund_before_response' } },
    );
    assert.equal(released.status, 200);
    await assert.rejects(firstRefund);

    const retry = await call(baseUrl, refundPath, { body: refundBody });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).status, 'refunded');
    assert.equal((await ledger(baseUrl, 'run-refund')).refunds.length, 1);
  });
});

test('before_refund gate waits before adding a refund ledger record', async () => {
  await withServer(async ({ baseUrl }) => {
    await plan(baseUrl, 'run-refund-before', 'op-refund-before', {
      chargeOutcome: 'success',
      holdAt: null,
      refundOutcome: 'success',
      refundHoldAt: 'before_refund',
    });
    const charge = await call(baseUrl, '/v1/charges', {
      body: {
        runId: 'run-refund-before',
        operationKey: 'op-refund-before',
        amountMinor: 600,
        currency: 'USD',
      },
    });
    assert.equal(charge.status, 200);

    const refundPath = '/v1/refunds';
    const refundBody = {
      runId: 'run-refund-before',
      refundOperationKey: 'refund-before',
      originalOperationKey: 'op-refund-before',
    };
    const refundRequest = call(baseUrl, refundPath, { body: refundBody });
    await eventually(async () => {
      const state = await ledger(baseUrl, 'run-refund-before');
      return state.pendingRefunds.some((refund) => refund.waitingAt === 'before_refund');
    });
    const heldLedger = await ledger(baseUrl, 'run-refund-before');
    assert.equal(heldLedger.refunds.length, 0);

    const released = await call(
      baseUrl,
      '/_control/v1/runs/run-refund-before/operations/op-refund-before/release',
      { token: ADMIN, body: { phase: 'before_refund' } },
    );
    assert.equal(released.status, 200);
    assert.equal((await refundRequest).status, 200);
    const finalLedger = await ledger(baseUrl, 'run-refund-before');
    assert.equal(finalLedger.refunds.length, 1);
    assert.equal(finalLedger.pendingRefunds.length, 0);
  });
});

test('run cleanup refuses active provider operations and is idempotent once idle', async () => {
  await withServer(async ({ baseUrl }) => {
    await plan(baseUrl, 'run-clean', 'op-clean', {
      chargeOutcome: 'success',
      holdAt: 'after_capture_before_response',
    });
    const charge = call(baseUrl, '/v1/charges', {
      body: { runId: 'run-clean', operationKey: 'op-clean', amountMinor: 100, currency: 'USD' },
    });
    await eventually(async () => {
      const state = await ledger(baseUrl, 'run-clean');
      return state.operations.some((operation) => operation.waitingAt === 'after_capture_before_response');
    });

    const busy = await call(baseUrl, '/_control/v1/runs/run-clean', {
      token: ADMIN,
      method: 'DELETE',
    });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error.code, 'RUN_BUSY');

    const released = await call(
      baseUrl,
      '/_control/v1/runs/run-clean/operations/op-clean/release',
      { token: ADMIN, body: { phase: 'after_capture_before_response' } },
    );
    assert.equal(released.status, 200);
    assert.equal((await charge).status, 200);

    const cleaned = await call(baseUrl, '/_control/v1/runs/run-clean', {
      token: ADMIN,
      method: 'DELETE',
    });
    assert.equal(cleaned.status, 204);
    const replayedCleanup = await call(baseUrl, '/_control/v1/runs/run-clean', {
      token: ADMIN,
      method: 'DELETE',
    });
    assert.equal(replayedCleanup.status, 204);
    assert.deepEqual(await ledger(baseUrl, 'run-clean'), {
      runId: 'run-clean',
      operations: [],
      captures: [],
      refunds: [],
      pendingRefunds: [],
    });
  });
});
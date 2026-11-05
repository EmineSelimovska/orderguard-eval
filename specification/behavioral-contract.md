# OrderGuard Eval Behavioral Contract v1.1

**Status:** Authoritative public behavior contract for the Reference Backend and candidate implementations.

This document specifies externally observable behavior. It does not require a particular internal architecture, ODM pattern, locking strategy, or transaction strategy. The Reference Backend is an example implementation, not an oracle imported by the evaluator.

Cross-package provider HTTP, evaluator-only database observation, candidate distribution, and runtime decisions are specified in [Cross-Package Architecture Decisions v1.0](architecture-decisions.md). That document is part of the public candidate materials and does not alter the business behavior or scenarios in this contract.

## 1. Scope and terminology

The service is a Node.js JavaScript ES-module application using Express, Mongoose, and MongoDB Atlas. Tests use Jest and Supertest. TypeScript, Docker, local MongoDB, and real payment processing are out of scope. The only payment provider is the deterministic mock defined below.

Every benchmark request belongs to a unique `runId`. Business requests send it in `X-Benchmark-Run-Id`. Test setup and cleanup use the run ID in the path. Data and idempotency keys are scoped to a run. A run must not share products, orders, payments, or webhook records with another run.

The confirmed Atlas database is `orderguard_eval`, reached using a standard `mongodb://` URI with three shard hosts. **Transaction support is not verified.** Before any transaction-dependent test is designed or run, verify the connected topology and execute an actual transaction against this deployment. No contract behavior below mandates that a particular operation use a transaction.

### Common errors

Errors use this shape:

```json
{
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Requested quantity is unavailable"
  }
}
```

Messages are safe for clients and logs; credentials and connection strings must never be included. Invalid JSON returns `400 INVALID_REQUEST`. Validation errors return `422 VALIDATION_ERROR`. Unknown resources return `404 NOT_FOUND`. A state conflict returns `409` with a stable code. Unexpected dependency failures return `503 SERVICE_UNAVAILABLE`, except an upstream payment timeout, which returns `504`.

All business endpoints require `X-Benchmark-Run-Id`. The run ID must be a validated opaque identifier. The API does not assume customer authentication or expose customer data.

## 2. API contract

Amounts are integer minor currency units (for example, cents); floating-point amounts are forbidden. The supported currency allowlist is `USD`, `EUR`, and `GBP`. MVP orders contain exactly one product line. Quantity must be an integer from 1 through 100. Unit price and total order amount must each be at most `100000000` minor units. Validate multiplication safely before persisting; reject any order above the maximum with `422 VALIDATION_ERROR`.

### 2.1 Create an order

`POST /api/orders`

Headers: `X-Benchmark-Run-Id`, `Idempotency-Key`.

Request:

```json
{
  "sku": "SKU-1",
  "quantity": 2
}
```

Response (`201 Created`):

```json
{
  "order": {
    "id": "ord_…",
    "runId": "run_…",
    "status": "pending_payment",
    "items": [{ "sku": "SKU-1", "quantity": 2, "unitPriceMinor": 1250 }],
    "amountMinor": 2500,
    "currency": "USD",
    "payment": { "id": "pay_…", "status": "pending", "operationKey": "op_…" },
    "inventoryDisposition": "held"
  },
  "replayed": false
}
```

An exact replay using the same run ID, idempotency key, and normalized request returns `200 OK`, the same order/payment IDs and stored result, with `replayed: true`. Reusing a key with a different SKU or quantity returns `409 IDEMPOTENCY_KEY_REUSED`. Missing key/header returns `400`. Unknown SKU returns `404 PRODUCT_NOT_FOUND`. Insufficient stock returns `409 INSUFFICIENT_INVENTORY`; it creates no order or payment and reserves no stock. Validation errors return `422`.

Order creation atomically claims available inventory from the perspective of observable behavior. The stock reservation and order/payment creation must not leave an unrepairable partial order if one step fails.

### 2.2 Retrieve an order

`GET /api/orders/:orderId`

Response (`200 OK`) is the stored order representation above, including current order and payment states, amount, operation key, and inventory disposition. Unknown order in the specified run returns `404 NOT_FOUND`; malformed ID returns `400 INVALID_REQUEST`.

### 2.3 Cancel an order

`POST /api/orders/:orderId/cancel`

Optional request body: `{"reason":"customer_request"}`. Repeated cancellation after completion is idempotent.

- `200 OK`: cancellation completed; response has `status: "cancelled"`, payment `voided`, `declined`, or `refunded`, and inventory disposition `released`.
- `202 Accepted`: capture was discovered after cancellation won; compensation is in progress and order is `cancellation_pending_refund`.
- `409 ORDER_ALREADY_PAID`: payment/order success committed first. Paid-order cancellation/refunds are outside this MVP.
- `409 PAYMENT_OUTCOME_UNKNOWN`: payment is processing or ambiguous; retry/reconcile the same operation before deciding whether cancellation is safe.
- `404 NOT_FOUND`, `400 INVALID_REQUEST`, or `503 SERVICE_UNAVAILABLE` as applicable.

### 2.4 Attempt or retry payment

`POST /api/orders/:orderId/payment-attempts`

No client-selected outcome or provider key is accepted. The backend uses the operation key persisted when the order was created. Every retry of that order uses the same key. A decline is terminal for that order; a new attempt requires a new order. A timeout is not a decline.

- `200 OK`: payment succeeded and order is paid; includes `payment.status: "succeeded"`.
- `200 OK`: a matching success was already committed by a webhook; return the normal success representation without repeating database or inventory effects.
- `402 Payment Required`: mock provider declined; order is `payment_failed`, payment is `declined`, and stock is released. This order cannot be retried.
- `402 Payment Required`: a matching decline was already committed by a webhook; return the normal decline representation without repeating database or inventory effects.
- `409 PAYMENT_EVENT_CONFLICT`: a provider result contradicts an outcome already committed by a webhook; do not overwrite the committed state or repeat inventory effects.
- `504 Gateway Timeout`: known not processed leaves payment `pending`, or processed-but-response-lost leaves payment `unknown`. The response identifies `outcome: "not_processed"` or `outcome: "unknown"` without claiming a decline. Retry is allowed with the same operation key.
- `409 ORDER_NOT_PAYABLE`: order is paid, declined, cancelled, or otherwise terminal.
- `404 NOT_FOUND`, `400 INVALID_REQUEST`, or `503 SERVICE_UNAVAILABLE` as applicable.

Example timeout response:

```json
{
  "error": { "code": "PAYMENT_TIMEOUT", "message": "Payment outcome requires retry" },
  "payment": { "status": "unknown", "operationKey": "op_…" },
  "outcome": "unknown"
}
```

### 2.5 Process payment webhooks

`POST /api/webhooks/payments`

The mock provider sends `payment.succeeded` or `payment.declined` events. No real provider signature or credential is used. A deployment may add mock-only authentication, but it must not require real payment credentials.

Request:

```json
{
  "eventId": "evt_123",
  "type": "payment.succeeded",
  "paymentId": "pay_…",
  "operationKey": "op_…",
  "amountMinor": 2500,
  "currency": "USD"
}
```

- Every `200 OK` response uses the JSON body `{"eventId":"evt_123","processingResult":"applied","duplicate":false}` with the actual event ID, processing result, and duplicate flag substituted.
- `200 OK`: a valid outcome is applied, or a matching outcome already committed by the payment-attempt service is acknowledged without repeating state or inventory effects. A completed exact replay returns `200` with `duplicate: true`. For late-success compensation, a replay after refund completion returns `processingResult: "refund_completed"` and `duplicate: true`.
- `200 OK`: if late-success compensation completes during the current request, return `processingResult: "refund_completed"` and `duplicate: false`.
- `202 Accepted`: a late success after cancellation has been recorded and its idempotent refund remains pending. The body uses `processingResult: "refund_pending"`; `duplicate` is false if this request first recorded the event and true if the event was already recorded. Replaying resumes the refund with the same stable refund operation key. Return `202` while it remains pending and `200` with `processingResult: "refund_completed"` after completion.
- `400 INVALID_REQUEST`: malformed event.
- `404 PAYMENT_NOT_FOUND`: unknown payment/operation; event is not marked processed.
- `409 EVENT_ID_PAYLOAD_CONFLICT`: event ID was previously used with a different payload.
- `409 PAYMENT_EVENT_CONFLICT`: amount, currency, operation key, or state is inconsistent, or the event contradicts an already-applied payment outcome. A conflicting event is not marked processed.

Validate the request before computing `payloadHash`. The required `X-Benchmark-Run-Id` header is the sole source of `runId`; `runId` is not accepted in the JSON body. The body contains exactly `eventId`, `type`, `paymentId`, `operationKey`, `amountMinor`, and `currency`; reject missing or unknown fields. Build the canonical event as a JSON object with fields in exactly this order: `runId`, `eventId`, `type`, `paymentId`, `operationKey`, `amountMinor`, `currency`. Normalize `runId`, `eventId`, `paymentId`, and `operationKey` by trimming surrounding whitespace while preserving case and public ID prefixes. Require `type` to be exactly `payment.succeeded` or `payment.declined`, with no trimming or case conversion. Require `amountMinor` to be an integer and preserve its numeric value. Normalize `currency` by trimming and converting to uppercase, then validate it against supported currencies. Serialize the canonical object as compact UTF-8 JSON with no insignificant whitespace and compute its SHA-256 digest. The hash is independent of request property order and uses the normalized header run ID.

After computing the canonical payload hash, first look up `{runId, eventId}`. If it exists with a different hash, return `409 EVENT_ID_PAYLOAD_CONFLICT`. For an exact replay, return the recorded result without repeating completed effects; if its result is `refund_pending`, resume compensation as specified below. For a new event ID, resolve the run-scoped Payment and linked Order and validate the operation key, amount, and currency; an unknown Payment/operation returns `404 PAYMENT_NOT_FOUND` without recording the event.

Before applying eligibility rules for a new transition, recognize already-persisted matching outcomes: `Payment.succeeded` with `Order.paid` is a matching success; `Payment.declined` with `Order.payment_failed` is a matching decline; and `Payment.refunded` with `Order.cancelled` is a completed late-success compensation. Record this new event as `applied` for the first two pairs or `refund_completed` for the completed compensation, then acknowledge it without repeating state or inventory effects. Any mismatched pair or opposite outcome is contradictory and returns `409 PAYMENT_EVENT_CONFLICT` without recording that event.

For a new ordinary outcome, accept `payment.succeeded` only when Payment is `pending`, `processing`, or `unknown`. Accept `payment.declined` only when Payment is `processing` or `unknown`; a decline event for a `pending` Payment is inconsistent. A success event for Payment `voided` or `succeeded` is also accepted only as a late-capture compensation when the linked Order is `cancelled` or `cancellation_pending_refund`; it must put/keep Payment in `refund_pending` and Order in `cancellation_pending_refund`, not mark the Order paid or treat the matching capture as fully handled. In all cases, verify the run, payment/order linkage, operation key, amount, and currency.

Record a valid event atomically with the state changes it causes. `processingResult` is `applied` for a completed ordinary outcome; `refund_pending` after a late-success refund intent is committed; and `refund_completed` after compensation is durably completed. Persist the event and late-success refund intent, including a stable refund operation key, before calling the provider. Provider refund calls occur outside MongoDB transactions. On refund success, atomically persist Payment `refunded`, Order `cancelled`, and event `processingResult: "refund_completed"`. If the provider refund succeeds but this persistence fails, retain the durable `refund_pending` intent and retry the provider with the same key; its idempotent result permits safe completion. Replaying the event while the refund is pending resumes it; it must not return early merely because the event ID is already recorded.

Webhook processing and the payment-attempt result may race. Reconcile a losing update against persisted state: if the persisted Payment/Order pair matches the same outcome, acknowledge success or decline using the normal payment-attempt response (`200` or `402`) or webhook response, without repeating database or inventory effects. If the persisted state contradicts the outcome, return `409 PAYMENT_EVENT_CONFLICT` without overwriting committed state. A matching outcome from the payment-attempt service does not itself make a new webhook event a duplicate; `duplicate` describes whether that webhook event ID and payload were already recorded.

### 2.6 Test-only inventory setup and run cleanup

All endpoints under `/_test` exist only when `NODE_ENV=test` and a per-run `BENCHMARK_TEST_SECRET` is configured. Every request to these endpoints must include `X-Benchmark-Test-Secret` with the configured secret. Missing or incorrect secrets return `403 TEST_ENDPOINTS_DISABLED`. The secret must never be logged, included in errors, or forwarded to the payment provider. Test endpoints must be unmounted or return `404` in every non-test environment. They operate only on the path’s run ID.

`PUT /_test/runs/:runId/products/:sku`

Request:

```json
{ "name": "Test item", "available": 5, "unitPriceMinor": 1250, "currency": "USD" }
```

Returns `201 Created` for a new fixture product or `200 OK` for an idempotent setup of that SKU before orders exist. Invalid stock/price/currency returns `422`. Resetting a product while the run has active held orders returns `409 PRODUCT_HAS_ACTIVE_ORDERS`.

`DELETE /_test/runs/:runId`

If any business request for the specified run is active, or any payment-provider operation is unfinished, cleanup returns `409` with error code `RUN_BUSY` and does not delete run data. An active operation is one that has started but has not reached a terminal result or a state that is safe for cleanup. A state is safe for cleanup only when no in-flight request, provider retry, callback, refund, or background task can still modify the run’s data; an unknown payment outcome is not safe until reconciled. The evaluator must wait for the relevant requests and provider operations to finish, then retry cleanup. It must use completion signals/state checks rather than arbitrary `sleep` intervals for synchronization. Cleanup must never delete data while an operation could still modify it.

When no operation is active, cleanup deletes that run’s webhook events, payments, orders, and products in a referentially safe order. It returns `204 No Content`, is idempotent for an empty run, and must never delete another run’s data. Cleanup introduces no candidate synchronization hooks.

### 2.7 Normalized test observations

`GET /_test/runs/:runId/observations`

Requires `NODE_ENV=test`, `BENCHMARK_TEST_SECRET`, and the `X-Benchmark-Test-Secret` header, like every other `/_test` endpoint. Returns a normalized projection of this run’s persisted state, independent of collection names or internal schemas:

```json
{
  "runId": "run_…",
  "products": [{ "sku": "SKU-1", "available": 3 }],
  "orders": [{
    "id": "ord_…",
    "idempotencyKey": "key-1",
    "sku": "SKU-1",
    "quantity": 2,
    "status": "pending_payment",
    "inventoryDisposition": "held",
    "paymentId": "pay_…"
  }],
  "payments": [{
    "id": "pay_…",
    "orderId": "ord_…",
    "operationKey": "op_…",
    "status": "unknown",
    "amountMinor": 2500,
    "currency": "USD",
    "attemptCount": 1
  }],
  "processedWebhooks": [{
    "eventId": "evt_123",
    "payloadHash": "…",
    "processingResult": "applied"
  }]
}
```

The endpoint returns `200 OK`; arrays are empty when the run has no corresponding records. It must not include secrets or provider credentials. The snapshot is a candidate-reported observation, not independently authoritative proof of database contents. The evaluator must cross-check it with public business API responses and the independent mock-provider ledger, and verify persistence by restarting the backend and re-reading observable state. No collection names or internal schemas are prescribed.

## 3. Data model contract

Implementations may use different Mongoose model names or internal layouts, but persisted behavior must represent the following fields and uniqueness guarantees.

### 3.1 Product / Inventory

Required: `runId`, `sku`, `name`, `available` (integer >= 0), `unitPriceMinor` (integer >= 0), `currency` (uppercase supported code), timestamps. `available` means units not held by an active order. Creating a pending order decrements it; successful payment leaves it decremented; cancellation or decline restores it once.

Indexes: unique `{ runId: 1, sku: 1 }`; `{ runId: 1, updatedAt: 1 }` for scoped fixture cleanup.

### 3.2 Order

Required: `runId`, `idempotencyKey`, normalized `requestHash`, one item snapshot (`productId`, `sku`, `quantity`, `unitPriceMinor`, `lineAmountMinor`), `amountMinor`, `currency`, `status`, `paymentId`, `inventoryDisposition` (`held | consumed | released`), timestamps, and a version/state revision for compare-and-set updates.

Indexes: unique `{ runId: 1, idempotencyKey: 1 }`; `{ runId: 1, _id: 1 }`; `{ runId: 1, createdAt: 1 }`.

### 3.3 Payment

Required: `runId`, `orderId`, stable `operationKey`, `status`, `amountMinor`, `currency`, attempt count, last safe outcome, provider operation reference, optional refund operation key/reference, timestamps, and capture/refund timestamps where applicable.

Indexes: unique `{ runId: 1, orderId: 1 }`; unique `{ runId: 1, operationKey: 1 }`; unique provider reference when present.

### 3.4 Processed webhook event

Required: `runId`, `eventId`, canonical `payloadHash`, `paymentId`, `operationKey`, event type, processing result, and `processedAt`.

`processingResult` is one of `applied`, `refund_pending`, or `refund_completed`. Set it to `applied` when the event's ordinary outcome is durably applied or reconciled with an already-committed matching Payment/Order outcome. Set it to `refund_pending` atomically with the late-success refund intent, before calling the provider. Change it to `refund_completed` atomically with persisting Payment `refunded` and Order `cancelled`. Keep the record in `refund_pending` if the provider or completion persistence fails, so a replay can resume compensation.

Indexes: unique `{ runId: 1, eventId: 1 }`; `{ runId: 1, paymentId: 1, processedAt: 1 }`.

Indexes must be present and ready before a benchmark run starts. Duplicate-key errors are normal concurrency outcomes to handle, not server errors. If the deployment is sharded, index/shard-key compatibility must be confirmed before relying on a cluster-wide uniqueness claim.

## 4. State machines

### 4.1 Order states

States: `pending_payment`, `paid`, `payment_failed`, `cancellation_pending_refund`, `cancelled`.

| Initial state | Trigger and condition | Result | Reversible? | Concurrent outcome |
|---|---|---|---|---|
| None | Order creation claims stock and idempotency key | `pending_payment` | May proceed to a terminal result | Unique idempotency index permits only one order per run/key |
| `pending_payment` | Provider success or valid success webhook wins | `paid`; inventory `consumed` | No | Success webhook accepts Payment `pending`, `processing`, or `unknown`; conditional transition allows one winner; later cancel returns 409 |
| `pending_payment` | Provider decline wins | `payment_failed`; inventory `released` | No | Conflicting success/cancel must reconcile; do not overwrite terminal state |
| `pending_payment` | Cancellation wins while no capture is known | `cancelled`; inventory `released` | Normally no | A later success event may reopen compensation as below |
| `pending_payment` | Cancellation wins but a capture is already known | `cancellation_pending_refund`; inventory `released` | Yes, to `cancelled` | Exactly one refund operation is issued |
| `cancelled` | A late success event proves capture occurred | `cancellation_pending_refund` | Yes, to `cancelled` after refund | Do not mark order paid; atomically record the event and refund intent, then compensate outside the transaction |
| `cancellation_pending_refund` | Mock refund succeeds | `cancelled` | No | Replays resume a pending refund with the same stable key; repeated refund result is idempotent |
| `paid` | Cancel request | Forbidden; remains `paid` | No | Return `409 ORDER_ALREADY_PAID` |
| `payment_failed` | Retry same order | Forbidden | No | Return `409 ORDER_NOT_PAYABLE`; new order required |

An ambiguous timeout keeps the order `pending_payment`; payment status carries the uncertainty. Cancellation is rejected until retry/reconciliation establishes the provider result. Order state never moves backward from `paid` or `payment_failed`.

### 4.2 Payment states

States: `pending`, `processing`, `unknown`, `succeeded`, `declined`, `voided`, `refund_pending`, `refunded`.

| Initial state | Trigger | Result | Reversible? | Concurrent outcome |
|---|---|---|---|---|
| `pending` | Attempt starts | `processing` | Yes, while provider has not settled | Use same persisted operation key |
| `pending`, `processing`, or `unknown` | Provider succeeds / success event | `succeeded` | Only to `refund_pending` for a cancellation race | Success webhooks accept all three states; compare-and-set and event uniqueness prevent duplicate application |
| `processing` or `unknown` | Provider declines / decline event | `declined` | No | Decline webhooks accept only these states; a decline event in `pending` conflicts |
| `processing` | Known timeout before provider processing | `pending` | Yes | Retry same key; no charge exists |
| `processing` | Provider processed but response timed out | `unknown` | Yes, after same-key retry/reconciliation | Retry returns the stored provider result, not a new charge |
| `unknown` | Same-key retry/reconciliation yields success or decline | `succeeded` or `declined` | Success only to refund compensation | One terminal result is applied |
| `pending` | Cancellation wins before capture | `voided` | No | Later capture event is treated as late success and compensated |
| `succeeded` with Order `paid` | Matching success event or payment-attempt result is received | No state change | No | Recognize the matching terminal pair before eligibility checks; acknowledge with no repeated database or inventory effect |
| `declined` with Order `payment_failed` | Matching decline event or payment-attempt result is received | No state change | No | Recognize the matching terminal pair before eligibility checks; acknowledge with no repeated database or inventory effect |
| `refunded` with Order `cancelled` | Matching late-success event is received | No state change | No | Record/replay the event as `refund_completed`; do not issue another effective refund or inventory change |
| `succeeded` or `voided` | Late capture discovered while order cancellation won | `refund_pending` | Yes, to `refunded` | Persist refund intent and stable refund key before calling provider; replays resume with the same key |
| `refund_pending` | Mock refund succeeds | `refunded` | No | Persist completion with Order `cancelled` and event `refund_completed`; exact event replay returns `200 duplicate: true`; while pending, return `202` |
| `declined`, `refunded` | New charge attempt | Forbidden | No | Return conflict; do not create a new operation for the same order |

Webhook delivery and the payment-attempt response may race. Reconcile matching results as already applied, without repeating inventory effects; contradictory results must not overwrite persisted state and return `409 PAYMENT_EVENT_CONFLICT`. The persisted terminal state and provider ledger must agree. A late success after order cancellation is compensated, never silently discarded.

## 5. Mock payment provider contract

The provider is a deterministic test dependency, not a real payment integration. The evaluator controls outcomes out-of-band; candidates cannot choose outcomes in public request bodies. The benchmark test secret is never forwarded to this provider.

Interface behavior:

- `charge(runId, operationKey, amountMinor, currency)` can produce success, decline, timeout before processing, or the named `processed_response_timeout` outcome.
- The provider ledger is keyed by `(runId, operationKey)`. A repeated call in that run returns the original operation/result and never creates another charge.
- Timeout-before-processing is a definite no-charge result; payment returns to `pending` and can be retried with the same key.
- For `processed_response_timeout`, the mock provider successfully captures payment exactly once and sends no provider response to the backend. The backend returns `504` with `outcome: "unknown"`, stores payment status `unknown`, and leaves the order `pending_payment`. A retry with the same operation key returns the previously recorded success; no additional capture occurs. The backend applies the success, sets the order to `paid`, and returns `200`. A decline hidden by a response timeout is out of scope for v1.1.
- `refund(runId, refundOperationKey, originalOperationKey)` is available only for cancellation-race compensation. Repeats in that run return the first refund result and never refund twice.
- The mock exposes operation/capture/refund observations to the evaluator through its own harness, not through candidate business endpoints.
- Provider calls must occur outside MongoDB transactions. Persist intent before calling; persist result after. Recovery retries use stable keys.

## 6. Database consistency and recovery

### Atomic updates

Inventory reservation uses one conditional single-document update equivalent to “match this run/SKU and `available >= quantity`, then decrement.” No prior read can authorize a later unconditional decrement. State transitions use a conditional update matching the expected current state/version. Inventory release checks an order’s `inventoryDisposition` so the same order cannot restock twice.

MongoDB single-document writes are atomic. Unique indexes enforce order-key, payment-operation, and webhook-event uniqueness even when requests overlap. Mongoose’s `findOneAndUpdate()` is atomic except for an unindexed upsert; indexes required by this contract must be created before evaluation. [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [Mongoose atomic updates](https://mongoosejs.com/docs/tutorials/findoneandupdate)

Webhook event recording and its corresponding Payment, Order, and inventory transitions must commit atomically when they span multiple documents. The unique `{ runId, eventId }` index is the concurrency arbiter for duplicate deliveries; duplicate-key errors are normal concurrency outcomes. After a transaction abort caused by a competing delivery, read the winning event and compare its canonical payload hash before returning duplicate or payload-conflict. For an exact event replay with `processingResult: "applied"` or `"refund_completed"`, return `200` with `duplicate: true`. For an exact replay with `processingResult: "refund_pending"`, resume compensation outside the transaction; return `202` with `duplicate: true` if it remains pending, or `200` with `duplicate: true` after recording completion.

### Multi-document consistency

Observable behavior must not leave stock reserved with no recoverable order, payment/order states permanently contradictory, or stock released twice. Implementations may use a transaction for multi-document changes if the deployed topology supports it, or a durable, idempotent reservation/saga and recovery strategy. Transactions are appropriate for atomic inventory/order/payment state changes across documents; they are not required for reads, unique-index deduplication, or a single-document conditional update.

No external provider call may occur inside a transaction. Do not use `Promise.all` within a transaction. If transaction support is chosen, verify both topology and an actual transaction before depending on it in tests. If a saga is chosen, persist operation intent and enough state to resume/compensate after a process restart. Refund and stock-release operations must have stable identities and be idempotent.

## 7. Five benchmark scenarios

All scenarios assert both HTTP behavior and final observable state. Test data uses a fresh `runId`; no random sleeps are used.

### 7.1 Duplicate Order Prevention

- **Initial state:** Fixture product has 5 available; no order uses the key.
- **Sequence:** Two identical order requests with the same run ID/key/body are released together.
- **Expected:** One order/payment; both responses identify the same order; one stock reservation.
- **Invariants:** One order per `(runId, idempotencyKey)`; replay has no extra inventory or payment effect; key/body mismatch is rejected.
- **Responses:** One `201`, one replay `200`; changed body gives `409 IDEMPOTENCY_KEY_REUSED`.
- **Concurrency:** Evaluator gates both HTTP sends and releases them in one coordinated batch. Unique index is the final arbiter.

### 7.2 Inventory Race Condition

- **Initial state:** Product has 1 available.
- **Sequence:** Two distinct keys each order quantity 1; requests are released from one external start barrier.
- **Expected:** One accepted order, one stock conflict; final available is 0.
- **Invariants:** Never negative; accepted quantity does not exceed initial quantity; only accepted order holds stock.
- **Responses:** One `201`, one `409 INSUFFICIENT_INVENTORY`.
- **Concurrency:** Distinguish two experiments. (1) A validation-only forced-race mutant can pause after both contenders read the same stock value, then release both writes; this validates that the invariant checker detects the forced faulty outcome. This instrumentation belongs only to the deliberately faulty validation mutant and is not a required candidate hook. (2) Ordinary candidates receive repeated fixed concurrent request batches released by an external start barrier. These batches do not guarantee internal read/write overlap. Do not claim deterministic detection of uninstrumented read-then-write implementations unless experiments demonstrate reliable detection; report results for faulty and correct controls.

### 7.3 Duplicate Payment Webhook

- **Initial state:** Pending order/payment; mock ledger has one success for its operation key.
- **Sequence:** Deliver the same success event twice, with a second run delivering both copies concurrently; separately reuse the ID with altered payload.
- **Expected:** One effective transition and one processed-event record; exact replay is acknowledged; altered event is rejected. A matching already-persisted `succeeded`/`paid` or `declined`/`payment_failed` pair is recognized before new-transition eligibility and causes no second effect.
- **Invariants:** Success is accepted from Payment `pending`, `processing`, or `unknown`; decline is accepted from `processing` or `unknown` only. Matching already-applied outcomes are idempotent; contradictory outcomes conflict. No duplicate capture, order transition, or inventory effect; payment amount/currency/key match order; event identity and payload hash are unique/consistent per run.
- **Responses:** Successful webhook bodies contain `eventId`, `processingResult`, and `duplicate`. New ordinary outcomes return `200` with `processingResult: "applied"` and `duplicate: false`; matching attempt-service outcomes use the same response. Exact replay after ordinary application or completed compensation returns `200` with `duplicate: true` and the stored result. Altered payload returns `409 EVENT_ID_PAYLOAD_CONFLICT`.
- **Concurrency:** Evaluator releases duplicate webhook HTTP requests together; unique index and conditional transition serialize the effect.

For a late success after cancellation, persist the webhook and refund intent before calling the provider. Set event `processingResult` to `refund_pending`; a new request that leaves compensation pending returns `202` with `duplicate: false`. A replay resumes the refund with the same stable refund key and returns `202` with `duplicate: true` while pending, or `200` with `processingResult: "refund_completed"` and `duplicate: true` after completion. If a webhook and payment-attempt result race, matching outcomes reconcile without duplicate inventory effects: the payment-attempt endpoint returns its normal `200` success or `402` decline response, and the webhook returns `200` with `processingResult: "applied"`. A contradictory outcome returns `409 PAYMENT_EVENT_CONFLICT` and does not overwrite persisted state.

### 7.4 Payment Timeout & Retry

- **Initial state:** Pending order/payment with a persisted stable operation key.
- **Sequence:** (a) provider times out before processing, then retry; (b) provider captures then times out response, followed by retry with the same operation key.
- **Expected:** Case (a) has zero capture until retry. For `processed_response_timeout`, the provider captures successfully once but sends no response; the first request returns `504`/unknown and the order remains `pending_payment`. Retry with the same key returns the stored success, creates no additional capture, marks the order paid, and returns `200`. A decline hidden by response timeout is out of scope for v1.1.
- **Invariants:** Timeout is not decline; no duplicate charge/operation; order is never paid without provider success; same operation key is retained.
- **Responses:** First attempt `504`; retry `200` on success or `402` on decline. Processed-but-response-lost timeout reports `unknown`.
- **Concurrency:** Evaluator-controlled mock gates the provider before processing or after capture/before response. The evaluator releases retry only after the mock reports the intended provider-side state.

### 7.5 Cancellation vs Payment Race

- **Initial state:** Pending order with one held unit; mock success is available for its payment operation.
- **Sequence:** Race cancel against payment success application/webhook. Run both release orders. Include a late success event after cancellation has completed.
- **Expected:** If success commits first, order is paid and cancel returns `409`. If cancellation wins before capture, order is cancelled, payment voided, stock released. If capture exists but cancellation wins before app success, order enters `cancellation_pending_refund`, payment enters `refund_pending`, then order becomes cancelled after one refund. A late capture after cancellation follows the same compensation path.
- **Invariants:** No cancelled order with uncompensated capture; no duplicate charge/refund or stock restoration; paid order is not silently cancelled.
- **Responses:** Winning transition `200`; cancellation against paid/unknown outcome `409`; pending compensation `202`; webhook that initiates compensation `202`.
- **Concurrency:** Evaluator uses the provider gate and webhook delivery to order events externally, then releases operations in each intended order. No candidate hook is required.

## 8. Testing, isolation, and validation

- Use Jest and Supertest for service/API tests. Suggested organization: `reference-backend/tests/` for reference-specific contract conformance; `evaluator/tests/` for evaluator fixtures and scoring tests. Do not share implementation helpers between those suites.
- Allocate a unique `runId` per test or scenario attempt. Seed with test-only product endpoints or evaluator-owned setup. Cleanup by run ID in `finally`/Jest teardown; cleanup is idempotent and scoped.
- Ensure required indexes are ready before issuing concurrent requests. Verify final database state and the mock provider ledger in addition to responses.
- Use explicit latches and fixed event/request release plans, not random delays. Provider gates control payment races. Inventory validation separates a forced-race faulty-mutant positive control from repeated ordinary external concurrent batches. No candidate synchronization hooks are required; external batches do not prove that an arbitrary implementation’s internal read/write interleaving occurred.
- Protect every `/_test` endpoint with `NODE_ENV=test` and `X-Benchmark-Test-Secret`, configured through `BENCHMARK_TEST_SECRET`. Keep the secret out of logs, business requests, provider requests, and committed files.
- Cross-check the normalized observation endpoint with public business API responses and the evaluator-owned mock-provider ledger. Restart the backend and re-read relevant state to check persistence. Do not treat candidate-reported observations alone as independent proof of database contents.
- Test the evaluator against the Reference Backend and deliberately faulty candidates (for example, no unique key, read-then-write stock check, webhook without dedupe, new key on retry, or cancel overwriting a paid order). Evaluator code must interact through documented interfaces and observable state only.
- Transaction-dependent validation is blocked on verifying the live Atlas topology and a real transaction. Contract behavior can be implemented with a verified transaction strategy or a durable non-transaction strategy; tests must match the deployed design without weakening observable invariants.

### Candidate restart and persistence verification procedure

The evaluator must use this procedure for scenarios whose state is expected to survive a backend restart:

1. Start the candidate backend as a separate Node.js child process.
2. Pass the required environment variables, including `NODE_ENV=test`, the MongoDB configuration, and `BENCHMARK_TEST_SECRET`, through the child process environment. Do not write secrets to logs or command-line arguments. No specific child-process management library is required.
3. Create a unique `runId` and execute a scenario that leaves state to verify after restart.
4. Wait until all requests and operations that must finish before restart have reached the scenario-defined safe point. Do not use arbitrary sleeps as synchronization.
5. Stop the backend gracefully, then start it again with the same configuration and the same MongoDB database. Restart must not reinitialize or delete the run’s data.
6. Verify the preserved state through the public business API and `GET /_test/runs/:runId/observations`. The `runId` and its data must remain intact. Verify that the state was preserved in MongoDB, not merely that the process starts again: the evaluator must use a read-only MongoDB observer to enumerate collections and find the run-scoped records by their contract-required `runId` field, without assuming collection names. Compare that persisted state with the API and normalized observation results.
7. Verify the independent payment-provider ledger when required by the scenario. The provider ledger is external to the candidate backend and must remain consistent with captured/refunded operations.
8. Perform cleanup only after all verification steps have completed and all relevant requests/provider operations are safe for cleanup. If cleanup returns `409 RUN_BUSY`, wait for completion signals/state to become safe, then retry; do not use arbitrary sleeps.

The observation snapshot is candidate-reported and is not independently authoritative proof of database contents. The evaluator must cross-check it with the public API, read-only MongoDB observations, and the independent provider ledger as applicable.

## 9. Physical architecture separation

Recommended top-level separation:

```text
reference-backend/       # Correct example API and its own tests
candidate-starter/       # Runnable Node/Express/Mongoose interfaces and infrastructure only
evaluator/               # Independent black-box runner, provider harness, assertions, reports
specification/           # This public contract and candidate task materials
```

The Candidate Starter contains no order, inventory, payment, webhook, retry, or race-resolution business logic. It may contain server setup, database configuration, request/response types as JavaScript interfaces/stubs, fixture plumbing, and the provider client contract. Test-only fixture endpoints are infrastructure required by this contract, not business logic.

The Independent Evaluator must not import Reference Backend routes, models, services, or helpers. It launches the candidate, drives documented HTTP/provider interfaces, inspects only evaluator-authorized database/provider observations, and reports observable outcomes. Reference-only tests are not evaluator tests.

## 10. Objective observations and critical failures

Report per scenario and per invariant, without numerical weights in this version:

- Orders and payment records per idempotency key/operation key.
- Requested/accepted quantities, initial/final available stock, and any negative stock observation.
- Webhook deliveries versus unique processed events and effective transitions.
- Provider operations, captures, and refunds per stable key.
- Final order/payment states, inventory disposition, and invalid or contradictory combinations.
- HTTP status/error codes, unexpected failures, and whether retries/replays returned consistent results.

Critical invariant categories that must cap the overall score (exact cap/weight is intentionally not set): overselling or negative inventory; duplicate effective order for one idempotency key; duplicate charge/refund; payment/order state contradiction; cancelled order with uncompensated captured payment; or non-idempotent duplicate webhook effects. Reports must state which critical invariant failed and the evidence. Do not invent results or claim scientific validation.

## 11. Remaining verification and technical issues

No product-level design approval remains outstanding for v1.1. The following are implementation/validation tasks, not permissions to weaken this contract:

1. Verify Atlas deployment topology and execute an actual transaction before designing/running transaction-dependent tests.
2. Validate that the evaluator’s external inventory request barrier detects deliberately faulty read-then-write implementations reliably. Black-box HTTP release cannot force internal interleaving without a shared hook; candidate hooks are explicitly not required.
3. Implement test-mode isolation and per-run secret provisioning without logging or forwarding the secret.
4. Validate that the normalized observation projection, public API, restart checks, and provider ledger are consistent without relying on candidate-reported observations alone.

This contract describes intended benchmark behavior only. It does not claim that OrderGuard Eval is novel, validated, or that any implementation passes.

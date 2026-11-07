# OrderGuard Eval — Candidate Implementation Instructions

## Objective

Implement a reliable e-commerce order-processing backend in the provided Candidate Starter package.

Your implementation must satisfy the authoritative **Behavioral Contract v1.1** and the shared integration interfaces defined in **Cross-Package Architecture Decisions v1.0**.

The goal is not simply to make individual API requests succeed. The implementation must preserve correctness under concurrency, retries, duplicate requests, payment failures, cancellation races, and process restarts.

## 1. Implementation Scope

Implement the required behavior within the `candidate-starter/` package.

Your implementation must provide:

- Public order creation and order retrieval endpoints.
- Atomic inventory reservation and run-scoped inventory management.
- Idempotent order creation and conflict handling.
- Payment-attempt processing and retry reconciliation.
- Order cancellation and the required cancellation state transitions.
- Payment webhook processing, including duplicate and conflicting event handling.
- Refund compensation for successful payments received after cancellation.
- Protected test-only setup, cleanup, and observation endpoints.
- The persistence and data models required by the behavioral contract.

Follow all request formats, response formats, status codes, validation rules, and state transitions specified in the contract.

## 2. Candidate Starter Restrictions

- Keep your implementation inside the Candidate Starter package.
- Do not import, copy, or depend on Reference Backend business logic.
- Do not access Evaluator internals or import Evaluator modules.
- Do not modify the behavioral contract or shared integration interfaces.
- Do not modify the Mock Provider or its evaluator-controlled interfaces.
- Do not introduce candidate-only synchronization hooks or special evaluator shortcuts.
- Do not rely on in-memory state as a replacement for required persistent state.

You may organize your implementation into additional modules within the Candidate Starter package.

## 3. Payment Provider Integration

Use only the deterministic Mock Provider protocol defined in the architecture decisions.

The Candidate Backend must use the restricted provider client interface for charge and refund operations.

Requirements:

- Use stable, persisted operation keys.
- Preserve provider idempotency across retries.
- Correctly handle success, decline, timeout-before-processing, and processed-but-response-lost outcomes.
- Reconcile uncertain operations without creating duplicate charges or refunds.
- Never allow public business requests to select provider outcomes.
- Do not integrate real payment services.

Provider administration, control, and ledger interfaces are evaluator-side interfaces. They must not be used by the Candidate Backend.

## 4. Isolation, Transactions, and Consistency

Preserve all behavioral contract invariants, including:

- Every request and persisted record must be scoped to the supplied benchmark run identifier.
- Idempotency keys must be scoped to the appropriate run.
- Inventory reservation and order/payment creation must preserve the required atomicity.
- Concurrent operations must not produce overselling or duplicate side effects.
- Payment, order, cancellation, and refund states must remain consistent.
- Duplicate webhook deliveries must not repeat business effects.
- Required state must survive process restarts.

External provider calls must follow the transaction and consistency requirements in the architecture decisions. Do not hold database transactions open while waiting for external provider operations.

## 5. Runtime and Environment

The candidate archive targets:

- Node.js 24 LTS
- npm 11
- MongoDB Atlas with transaction support

The Evaluator supplies runtime configuration through process environment variables.

The Candidate Backend receives only:

- `NODE_ENV`
- `PORT`
- `MONGODB_URI`
- `BENCHMARK_TEST_SECRET`
- `MOCK_PROVIDER_URL`
- `MOCK_PROVIDER_CLIENT_TOKEN`

Do not expect a local `.env` file to be supplied or load evaluator credentials from other packages.

Security requirements:

- Use `BENCHMARK_TEST_SECRET` only to protect test-only endpoints.
- Never log credentials or expose them in API responses.
- Never forward `BENCHMARK_TEST_SECRET` to the Mock Provider.
- Never require or accept provider administration credentials.
- Never require or accept the Evaluator's read-only database observer credentials.

Keep the package independently installable using its own `package.json` and `package-lock.json`.

## 6. Evaluator Compatibility

The Evaluator launches the Candidate Backend as a separate process and interacts with it through the documented HTTP interfaces.

Your implementation must:

- Start using the package's configured start command.
- Listen on the supplied `PORT`.
- Bind to the expected local interface.
- Connect to MongoDB using `MONGODB_URI`.
- Communicate with the Mock Provider using its documented client interface.
- Expose the required public and protected endpoints.
- Support run-scoped cleanup and independent state observation as specified by the contract.
- Shut down cleanly when the process receives termination signals.

Do not change evaluator/provider control interfaces or require the Evaluator to import candidate-specific modules.

## 7. Evaluation

The Evaluator independently runs six scenarios:

1. **Duplicate Order Prevention**
2. **Inventory Race Condition**
3. **Duplicate Payment Webhook**
4. **Payment Timeout and Retry**
5. **Cancellation vs. Payment Race**
6. **Persistence After Restart**

Evaluation checks include public API behavior, persisted MongoDB state, and independent Mock Provider ledger observations.

Candidate-reported observations are not authoritative and cannot replace the required externally observable behavior.

The implementation must satisfy the complete behavioral contract, not just the individual happy paths described by the scenario names.

## 8. Final Requirements

Before considering the implementation complete:

- Verify that all required endpoints and behaviors are implemented.
- Verify that the package installs independently.
- Verify that the application starts with the environment supplied by the Evaluator.
- Verify that all required data is persisted.
- Verify that retries and duplicate requests preserve idempotency.
- Verify that the implementation does not depend on Reference Backend or Evaluator internals.

**Success means satisfying the behavioral contract under the Evaluator's independent checks, including concurrency, failure recovery, and persistence—not merely returning successful HTTP responses.**
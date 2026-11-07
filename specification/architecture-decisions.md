
# OrderGuard Eval — Cross-Package Architecture Decisions v1.0

## 1. Purpose and Scope

This document defines the architectural boundaries, process responsibilities, security requirements, and shared interfaces for OrderGuard Eval.

The system consists of four independently defined components:

1. **Reference Backend** — the known-good implementation used to validate the contract and evaluator.
2. **Candidate Starter** — the isolated starting point provided to AI coding models for implementation.
3. **Mock Provider** — a separate deterministic payment-provider service owned and controlled by the evaluator.
4. **Evaluator** — the independent benchmark runner responsible for scenario execution, observation, assertions, and reporting.

The benchmark currently contains six scenarios covering order idempotency, inventory concurrency, duplicate webhooks, payment timeout recovery, cancellation/payment races, and persistence after restart.

The Behavioral Contract v1.1 is the source of truth for required candidate behavior. This document defines how the components interact without duplicating the contract.

## 2. Process and Responsibility Boundaries

### 2.1 Candidate and Reference Backend

The Candidate and Reference Backend run as separate Node.js processes.

Both must implement the same public HTTP interface and interact with the Mock Provider through its restricted client API.

The candidate process:

- Owns its application logic and MongoDB writes.
- Implements order, inventory, payment, cancellation, and webhook behavior.
- Uses the Mock Provider for charge and refund operations.
- Exposes the required test-only endpoints.
- Must not access evaluator-only provider controls, provider ledger data, or observer credentials.

The Reference Backend is a separate implementation used as a known-good validation target. The Evaluator must not import its routes, models, services, or business-logic helpers.

### 2.2 Mock Provider

The Mock Provider runs as a separate process.

It exposes two logically separate interfaces:

**Candidate-facing data plane**

- `POST /v1/charges`
- `POST /v1/refunds`

These endpoints require the restricted provider client token.

Charge requests use:

```json
{
  "runId": "benchmark-run-id",
  "operationKey": "stable-charge-operation-key",
  "amountMinor": 1250,
  "currency": "USD"
}
```

Refund requests use:

```json
{
  "runId": "benchmark-run-id",
  "refundOperationKey": "stable-refund-operation-key",
  "originalOperationKey": "stable-charge-operation-key"
}
```

Provider operations must be idempotent and scoped by `runId` and their operation keys.

**Evaluator-only control plane**

- `PUT /_control/v1/runs/:runId/operations/:operationKey`
- `POST /_control/v1/runs/:runId/operations/:operationKey/release`
- `GET /_control/v1/runs/:runId/ledger`
- `DELETE /_control/v1/runs/:runId`

These endpoints require the provider admin token and must never be exposed to the candidate process.

The evaluator configuration uses `EVALUATOR_MOCK_PROVIDER_ADMIN_TOKEN`. When starting the Mock Provider child process, the Evaluator maps this value to `MOCK_PROVIDER_ADMIN_TOKEN`. The candidate process receives neither variable.

The Mock Provider supports deterministic outcomes and externally controlled operation gates, including:

- Successful charge.
- Declined charge.
- Timeout before processing.
- Processing completed but response lost.
- Controlled operation holds and releases.
- Refund outcomes and refund operation holds.

Provider calls must occur outside MongoDB transactions.

## 3. MongoDB Ownership and Independent Observation

The Candidate and Reference Backend use their own MongoDB connections and own all application writes.

The Evaluator uses a separate MongoDB observer connection through `OBSERVER_MONGODB_URI`. This connection is intended for read-only observation and must not be passed to the candidate process.

The MongoDB observer has been implemented in the Evaluator using the native MongoDB Node.js driver. It:

- Discovers database collections.
- Queries documents by top-level `runId`.
- Returns run-scoped persisted records for independent verification.
- Applies a maximum document limit per collection.

The observer has been exercised successfully against the configured Atlas deployment during the six-scenario Reference Backend validation run, including the persistence-after-restart scenario.

The observer uses a separate `OBSERVER_MONGODB_URI` and is not passed to the candidate process. Read-only MongoDB permissions must be maintained and verified independently as part of deployment and credential provisioning. Dedicated write-denial verification should be completed if it has not already been performed.

The evaluator must not rely solely on candidate-reported observations. It independently compares:

1. Public API responses.
2. Candidate normalized observations.
3. Persisted MongoDB records.
4. Mock Provider ledger entries.

Candidate observations are useful for normalized inspection but are not authoritative evidence by themselves.

MongoDB collection names are implementation-defined. The observer discovers collections and retrieves documents associated with the requested `runId`.

## 4. Evaluator Responsibilities and Candidate Isolation

The Evaluator owns:

- Scenario definitions and execution order.
- Candidate process lifecycle.
- Mock Provider process lifecycle.
- Provider outcome configuration and operation release.
- Provider ledger inspection.
- Read-only MongoDB observation.
- Assertions and invariant checks.
- Final benchmark report generation.

The Evaluator must launch the selected implementation as a child process and interact with it through documented HTTP interfaces.

The Evaluator must not import Reference Backend business logic or use candidate-only synchronization hooks.

### 4.1 Candidate Environment

The candidate process receives only the following environment variables:

- `NODE_ENV`
- `PORT`
- `MONGODB_URI`
- `BENCHMARK_TEST_SECRET`
- `MOCK_PROVIDER_URL`
- `MOCK_PROVIDER_CLIENT_TOKEN`

The candidate must not receive:

- Provider admin credentials.
- Provider ledger access credentials.
- Evaluator control-plane credentials.
- `OBSERVER_MONGODB_URI`.
- Any evaluator-only database observer credentials.

The evaluator constructs the candidate environment using an explicit allowlist rather than inheriting its entire environment.

### 4.2 Provider Environment

The Mock Provider receives its own restricted process environment, including:

- `NODE_ENV`
- `PORT`
- `MOCK_PROVIDER_CLIENT_TOKEN`
- `MOCK_PROVIDER_ADMIN_TOKEN`

The admin token is supplied to the provider process by the Evaluator from its own configuration. It is not passed to the candidate.

### 4.3 Candidate Archive

The candidate snapshot must be treated as an immutable input to an evaluation run.

The evaluator should:

- Use a fresh working directory for each candidate evaluation.
- Preserve the candidate's package-specific `package.json` and `package-lock.json`.
- Install dependencies from the candidate package independently.
- Avoid modifying candidate source files during evaluation.
- Keep evaluator and provider dependencies outside the candidate package.

Archive creation and release automation should be handled separately from scenario execution.

## 5. Runtime and Installation Requirements

The benchmark runtime baseline is:

- Node.js 24 LTS.
- npm 11.
- MongoDB Atlas with transaction support.
- ES modules.
- JavaScript.

The package engine requirements should remain within:

```json
{
  "engines": {
    "node": ">=24 <25",
    "npm": ">=11 <12"
  }
}
```

Each independently executed package must declare its own dependencies and have a package lockfile.

The Candidate Starter must remain independently installable and runnable. The Evaluator must not depend on the candidate being part of the root npm workspace for installation or execution.

The Mock Provider must also remain independently runnable as a separate process.

## 6. Verified Infrastructure and Remaining Operational Checks

The following implementation and infrastructure decisions have been verified:

1. **MongoDB Atlas topology and transactions**

   The configured Atlas deployment has been verified as an unsharded three-member replica set running MongoDB 8.0.36. A transaction diagnostic successfully committed, aborted, read back, and cleaned up test data. Transaction support has therefore been verified for this deployment. Any future topology or sharding change requires renewed transaction validation.

2. **Reference Backend persistence**

   The Reference Backend has been exercised against the configured Atlas deployment. Its transaction-based order creation and inventory reservation behavior passed the benchmark validation scenarios.

3. **Mock Provider separation**

   The Mock Provider runs as a separate service with distinct candidate-facing and evaluator-only interfaces. The candidate uses only the restricted client token.

4. **Evaluator process isolation**

   The Evaluator launches the selected backend as a child process and supplies an explicit environment allowlist.

5. **Six-scenario validation**

   The Reference Backend completed all six benchmark scenarios successfully, with 86 of 86 assertions passing. The persistence-after-restart scenario verified that the order, payment, and inventory state remained persisted after the backend process restarted.

6. **MongoDB observer**

   The observer implementation has been exercised against the configured Atlas deployment and used to verify persisted records and restart persistence. Dedicated read-only role permissions and write-denial behavior must still be verified explicitly if not already tested.

7. **Archive and release automation**

   The Candidate Starter has its own package lockfile. Automated archive creation, release packaging, and final archive validation remain separate release tasks.

## 7. Architectural Invariants

The following boundaries must remain in place:

- The Behavioral Contract is the source of truth for candidate behavior.
- The Evaluator remains independent of Reference Backend business logic.
- The Mock Provider remains a separate process.
- Candidate and evaluator credentials remain separated.
- All benchmark data remains scoped by `runId`.
- Provider charge and refund operations remain idempotent.
- Provider calls remain outside database transactions.
- The evaluator independently checks persisted state and provider-side effects.
- The Candidate Starter remains independently installable.
- No candidate-only synchronization hooks may be introduced to simplify evaluation.


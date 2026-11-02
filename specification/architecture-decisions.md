# OrderGuard Eval Cross-Package Architecture Decisions v1.0

**Status:** Normative architecture decisions for implementing Behavioral Contract v1.1.

This document fixes the integration boundaries shared by the Reference Backend, Candidate Starter, Evaluator, and deterministic mock payment provider. It does not change the business behavior or the five scenarios in [Behavioral Contract v1.1](behavioral-contract.md). The public contract and this document are both part of every candidate task package. The Reference Backend remains an example implementation; the Evaluator must not import or execute its business code.

## 1. Component ownership and boundaries

- **Candidate backend process:** Implements the contract, owns its MongoDB writes, and calls the mock provider's charge/refund data plane. It receives no provider control, ledger-administration, or evaluator database-observer credentials.
- **Mock provider service:** A deterministic HTTP service owned and launched by the Evaluator. It owns the provider operation/capture/refund ledger and provider outcome plans. It is a separate process/service boundary from the candidate business API, even if all processes run on one host.
- **Evaluator process:** Owns scenario orchestration, provider control, provider ledger reads, the read-only MongoDB observer, candidate process lifecycle, assertions, and reports. It talks to a candidate only through the documented business/test HTTP interfaces and process lifecycle.
- **Reference Backend:** Implements the same candidate-facing contract and provider data-plane protocol as a control implementation. Evaluator scenario code may target it as a process but must not import its models, routes, services, helpers, or app factory.

The provider's control and ledger interfaces are private harness interfaces. They are not candidate-facing business endpoints and are never mounted on the candidate backend.

## 2. Mock payment provider HTTP protocol

The provider exposes separate data-plane and evaluator-control credentials and routes. All routes use JSON. Credentials are bearer tokens in the `Authorization` header, never in URLs, request bodies, or logs. The benchmark test secret is not accepted by or forwarded to the provider.

### 2.1 Candidate-to-provider data plane

The candidate receives `MOCK_PROVIDER_URL` and a restricted `MOCK_PROVIDER_CLIENT_TOKEN`. That token permits only charge and refund calls. It does not permit setting outcomes, releasing gates, or reading the ledger.

`POST /v1/charges`

```json
{
  "runId": "run-opaque-id",
  "operationKey": "op-stable-id",
  "amountMinor": 2500,
  "currency": "USD"
}
```

The provider idempotency identity is `(runId, operationKey)`. Repeating the same request returns the stored operation result without a second capture. Reusing that identity with different amount or currency returns `409 IDEMPOTENCY_CONFLICT`. A successful or declined operation returns `200` with `{ "runId", "operationKey", "status": "succeeded" | "declined", "providerReference" }`. A known timeout before processing returns `504` with `{ "code": "NOT_PROCESSED", "runId", "operationKey" }`; it has no capture and the same key can be retried. For `processed_response_timeout`, the provider persists exactly one successful capture and deliberately closes the response without sending an HTTP result. A repeated same-key charge returns the previously recorded success.

`POST /v1/refunds`

```json
{
  "runId": "run-opaque-id",
  "refundOperationKey": "refund-stable-id",
  "originalOperationKey": "op-stable-id"
}
```

The refund identity is `(runId, refundOperationKey)`. A repeated identical request returns the first refund result and never refunds twice. Reuse with a different original operation returns `409 IDEMPOTENCY_CONFLICT`. A successful refund returns `200` with `{ "runId", "refundOperationKey", "originalOperationKey", "status": "refunded", "providerReference" }`. Unknown or uncaptured original operations return `404 OPERATION_NOT_FOUND` or `409 REFUND_NOT_ALLOWED` respectively.

For either data-plane route: malformed requests return `400 INVALID_REQUEST`; invalid amount/currency returns `422 VALIDATION_ERROR`; missing or invalid client credentials return `401` or `403`; provider state conflicts return `409`; unavailable service failures return `503`. Error bodies use the contract's safe `{ "error": { "code", "message" } }` shape and never include credentials. A transport loss after acceptance is ambiguous to the candidate and must be handled according to the contract's unknown-outcome rules.

### 2.2 Evaluator control and ledger plane

The Evaluator alone receives `MOCK_PROVIDER_ADMIN_TOKEN`. It is distinct from both the candidate's restricted client token and `BENCHMARK_TEST_SECRET`. It can configure deterministic outcomes before an operation starts, release any explicitly configured provider gate, and inspect ledger state. The control interface is:

- `PUT /_control/v1/runs/:runId/operations/:operationKey` with `{ "chargeOutcome": "success" | "decline" | "timeout_before_processing" | "processed_response_timeout", "holdAt": null | "before_processing" | "after_capture_before_response" }`. Returns `201` when configured or `200` for an identical replay. Once the operation starts, a changed plan returns `409 OPERATION_ALREADY_STARTED`.
- `POST /_control/v1/runs/:runId/operations/:operationKey/release` with `{ "phase": "before_processing" | "after_capture_before_response" }`. Returns `200` when a held phase is released; unknown/unheld phases return `409 GATE_NOT_HELD`.
- `GET /_control/v1/runs/:runId/ledger` returns provider operation, capture, and refund records for that run, including stable keys, amount/currency, outcome, and references. It never returns auth tokens.
- `DELETE /_control/v1/runs/:runId` removes provider control plans and ledger entries after evidence has been recorded. It returns `204` for success or an already-empty run and `409 RUN_BUSY` while a provider operation is unfinished. The Evaluator must wait for completion signals/state and retry; it must not use arbitrary sleeps. This cleanup route requires the admin token and is never reachable with the candidate client token.

These control calls require the admin token. Invalid admin credentials return `401`/`403`; malformed control requests return `400`; unknown records return `404`; invalid state transitions return `409`. Outcome selection is keyed to run and operation identity and is set by the Evaluator, never by a candidate business request. The Evaluator may use provider state/completion responses and explicit release calls as synchronization; arbitrary sleeps are not synchronization.

The provider sends no unsolicited callback to the candidate. Where a scenario requires webhook delivery, the Evaluator obtains the relevant event facts from its authorized harness/ledger interface and sends the contract-defined event to the candidate's public webhook route. Provider capture/refund ledger records remain independent of candidate claims.

### 2.3 Provider transport and failure semantics

Provider calls happen outside MongoDB transactions. The backend persists operation intent and stable keys before calling; after a response it persists the result. On response loss, it records an unknown outcome and retries with the same operation key. The provider retains its ledger for the duration of a benchmark run and does not share records between runs.

For local evaluation, the provider binds to loopback and is reachable only by the candidate and evaluator processes on that host. The admin interface must not be exposed on the candidate's public listener. If the components are later placed on separate hosts, private network isolation and TLS become required before deployment; the distributed deployment mechanism is not specified here.

## 3. Independent read-only MongoDB observer

The Evaluator uses the MongoDB Node.js driver directly as an evaluator-owned, direct dependency; it must not rely on a transitive Mongoose dependency. It does not use Mongoose models, repositories, or services from either backend. It connects with `OBSERVER_MONGODB_URI`, a separate read-only MongoDB identity restricted to the benchmark database `orderguard_eval`; it is never passed to the candidate. The candidate receives its own `MONGODB_URI` write identity. The credential for the observer must permit collection discovery and reads only, with no writes, index changes, or administration. Credentials are provided through the evaluator process environment or protected runtime secret injection, not command-line arguments or logs.

### Observer MongoDB Identity

The Evaluator must use a dedicated MongoDB database user, separate from the Reference Backend and candidate database users. Scope its access to the `orderguard_eval` database and keep it read-only; prefer MongoDB's built-in `read` role on that database. The user must not be permitted to write data, modify indexes, create or delete collections, or manage users and roles.

### Observer Credential Isolation

The Evaluator uses a dedicated `OBSERVER_MONGODB_URI`, available only to the Evaluator process and never passed to candidate processes. Candidate processes must receive an explicit environment-variable allowlist, not the Evaluator's full environment. The URI must never appear in Git, candidate archives, source code, logs, or error messages.

### Observer Credential Provisioning and Rotation

The repository owner creates the dedicated read-only MongoDB user in Atlas and stores its credential in an approved secret manager or protected runtime environment. The Evaluator receives it as `OBSERVER_MONGODB_URI`. The owner verifies that the observer can perform the required reads and that write attempts are denied. To rotate, create a replacement credential, update the protected secret, verify the replacement, and only then revoke the old credential. Never store actual credentials or connection strings in documentation or committed files.

### Observer Verification Requirements

The Evaluator must verify that the observer can discover non-system collections in `orderguard_eval`, read records for a specific `runId`, and retrieve the minimum persisted fields required by Behavioral Contract sections 3.1–3.4 for products, orders, payments, and processed webhook events. Required reads must succeed with the observer identity, while a controlled write attempt must be denied. Missing or invalid observer credentials must cause a clear evaluator setup failure without exposing credentials. These are future implementation and verification requirements; they have **NOT** been implemented or tested yet.

Collection names are not part of the contract. The observer enumerates non-system collections, queries records by the required top-level `runId`, and classifies them using the contract's required fields and semantic identities. The minimum candidate persistence contract is therefore: each independently persisted Product/Inventory, Order, Payment, and Processed Webhook Event has a queryable top-level `runId` and persists the fields needed to represent that entity under sections 3.1–3.4 of the contract. Model and collection names, extra fields, and internal application structure remain implementation-defined. This is schema-independent only with respect to names and extra layout: it necessarily relies on the contract's required fields and top-level `runId`; it cannot verify a representation that omits or hides those required records.

The observer validates:

- **Run isolation:** records returned for a run carry only that `runId`; selected keys and records from a second run remain distinct.
- **Inventory:** initial fixture quantity versus persisted available quantity and accepted held/consumed/released order quantities; no negative stock or oversell.
- **Order/payment/idempotency:** persisted order and payment records grouped by run-scoped idempotency, operation, and relationship keys; contract states and amounts agree.
- **Webhook effects:** persisted unique event identities and results agree with the expected event and business state.
- **Restart persistence:** the same run-scoped records remain queryable after graceful stop and restart of the candidate process against the same database.

Evidence is recorded in four distinct channels and cross-checked:

1. **Public API evidence:** candidate business endpoint responses and retrievals.
2. **Candidate observation evidence:** the normalized `/_test/.../observations` projection; useful for correlation, but candidate-reported and never independent proof.
3. **Independent database evidence:** records read by the observer using its separate read-only identity.
4. **Provider evidence:** independent charge/capture/refund ledger records read with the evaluator-only provider admin credential.

No single candidate-reported channel is sufficient to prove persistence or provider effects. The database observer verifies durable candidate state; the provider ledger verifies external mock effects; public API and normalized observations are compared to both.

## 4. Candidate Starter distribution and process boundary

The Candidate Starter remains an npm workspace marked `private`; it is not assumed publishable to npm. Each benchmark release produces one immutable, versioned source archive containing:

- `candidate-starter/` at a fixed source revision;
- `specification/behavioral-contract.md` and this architecture decision document;
- `specification/candidate-instructions.md`;
- a candidate-package `package-lock.json` generated for the archive and validated with `npm ci`;
- a release manifest recording archive ID, file hashes, contract version, Node/npm versions, and dependency-lock hash.

The monorepo retains its single root `package-lock.json`. A candidate archive carries a package-specific lockfile generated during packaging; that artifact is not a second lockfile in the repository. The archive's install command and Node/npm versions are validated before release. Every model receives byte-identical archive contents, instructions, contract version, and baseline environment values. The Evaluator stores an archive hash and gives each candidate a fresh extraction/work directory. Candidate source changes, generated files, and runtime state are discarded after that candidate run; no edited checkout is reused for another model.

The Evaluator starts and stops each backend as a separate Node.js child process, waits for readiness through the public health endpoint, and sends graceful termination signals before enforcing a bounded process timeout. Configuration is passed in the child process environment, never logged or placed in command-line arguments. Candidate runtime variables are limited to what the backend needs: `NODE_ENV`, `PORT`, `MONGODB_URI` (candidate write identity), `BENCHMARK_TEST_SECRET` (required by test endpoints), `MOCK_PROVIDER_URL`, and the restricted `MOCK_PROVIDER_CLIENT_TOKEN`. The benchmark secret is not forwarded to the provider. The candidate receives neither `MOCK_PROVIDER_ADMIN_TOKEN` nor `OBSERVER_MONGODB_URI` nor any other evaluator/provider-control credential. Process output is captured with secret redaction and is not used as behavioral evidence.

## 5. Runtime version and reproducibility policy

Use the Node.js 24 LTS major line for the initial benchmark baseline, with the latest security-patched 24.x release selected and recorded for each benchmark release. As of this decision, Node.js 26 has only just transitioned to LTS; Node 24 is the more established baseline and is already the runtime in the current workspace. The current Mongoose 9 documentation requires Node 20.19.0 or newer, and Jest 30 requires Node 18.x or newer, so Node 24 meets both published minimums. The repository has not yet declared an engine range, and this policy does not claim every future dependency or candidate change has been tested on every Node 24 patch. [Node release schedule](https://nodejs.org/en/about/previous-releases), [Mongoose 9 Node requirement](https://mongoosejs.com/docs/migrating_to_9.html), [Jest 30 compatibility](https://jestjs.io/docs/upgrading-to-jest30).

When runtime configuration is added, record the supported range in `engines` in the root and all workspace manifests (`node >=24 <25`, `npm >=11 <12`), and pin the exact Node 24 patch in a root `.nvmrc` (or equivalent version-manager file). For each benchmark archive/release, record exact Node and npm patch versions in the release manifest. Keep npm 11 for the initial Node 24 baseline, use `npm ci` from the committed/generated lockfile, and do not update dependency versions as part of this architecture decision. Candidate packages distributed independently must carry the same runtime requirement and install lock information.

## 6. Unresolved decisions and required evidence

These are explicit follow-up tasks; none is evidence of verified Atlas behavior:

1. **Atlas topology, sharding, and transactions:** inspect deployment metadata and run a real transaction before any transaction-dependent test. Confirm shard-key compatibility for each required unique index if collections are sharded. Until then, use only design paths that do not assume transaction support, or validate a durable atomic/saga alternative.
2. **Credential provisioning and rotation:** choose the local/CI secret manager or protected environment injection for the candidate write URI, observer read-only URI, provider client token, and provider admin token. Confirm candidate processes never inherit the observer/admin values and logs redact all tokens and URIs.
3. **Provider network placement:** loopback is the initial local-run policy. Before distributed execution, select a private network/TLS deployment and rotate credentials accordingly.
4. **Archive release automation:** implement and validate archive generation, package-specific lock creation, hash manifest, fresh extraction, and byte-for-byte equality checks before model comparisons.
5. **Runtime compatibility checks:** add the engine/version files and verify the full Reference Backend, Evaluator, provider, and faulty/correct controls under the selected exact Node/npm versions before publishing an archive.
6. **Evaluator observer verification:** validate that the read-only identity can enumerate and read all required records on the chosen Atlas topology without write privileges, and test the required record-field classifier against multiple compliant persistence layouts.

No transaction support, Atlas topology, benchmark validity, or passing implementation is claimed by this document.

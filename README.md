# OrderGuard Eval

**A reproducible benchmark for evaluating AI coding models on reliable e-commerce order processing.**

OrderGuard Eval tests whether AI coding models can implement a transactional order-processing backend that remains correct under concurrency, retries, duplicate requests, payment failures, and cancellation races.

The benchmark focuses on behavioral correctness and independently observable system state—not merely whether an API returns the expected HTTP response.

## What It Evaluates

The benchmark evaluates whether a model can implement:

- Run-scoped data isolation and request idempotency.
- Atomic inventory reservation under concurrent order creation.
- Reliable payment processing and retry reconciliation.
- Idempotent webhook handling.
- Safe cancellation when payment operations are in flight.
- Compensation through refunds when a payment succeeds after cancellation.
- Persistence of correct state across process restarts.

These behaviors matter because failures in real e-commerce systems can cause overselling, duplicate charges, incorrect order states, and uncompensated payments.

## Benchmark Scenarios

OrderGuard Eval currently includes six scenarios:

1. **Duplicate Order Prevention** — concurrent requests using the same idempotency key must not create duplicate orders or reserve inventory more than once.
2. **Inventory Race Condition** — concurrent orders competing for the final unit of stock must not oversell inventory.
3. **Duplicate Payment Webhook** — repeated webhook deliveries must not produce duplicate payment or order-state transitions.
4. **Payment Timeout and Retry** — retries must reconcile uncertain provider outcomes without creating duplicate charges.
5. **Cancellation vs. Payment Race** — cancellation and payment completion must result in a consistent final state, including compensation for late successful payments.
6. **Persistence After Restart** — orders, payments, and inventory state must remain correct after the candidate process restarts.

Each scenario checks observable behavior and relevant persisted state.

## Architecture

The project separates the implementation under evaluation from the evaluation infrastructure.

- **Reference Backend (`reference-backend/`)** — a working reference implementation of the behavioral contract. It provides a baseline for validating the benchmark.
- **Candidate Starter (`candidate-starter/`)** — an infrastructure-only Node.js starter package. An AI coding model is expected to implement the contract using this starter.
- **Mock Provider (`mock-provider/`)** — a separate payment-provider simulator with idempotent charge and refund operations, deterministic outcomes, and evaluator-controlled operation gates.
- **Evaluator (`evaluator/`)** — launches the selected backend as a separate process, executes the scenarios, controls provider behavior, observes persisted database state independently, and generates reports.
- **Specification (`specification/`)** — contains the behavioral contract, architecture decisions, and candidate implementation instructions.

The Evaluator does not import Reference Backend business logic. It communicates with the selected backend through its HTTP interface and uses independent observation channels, including the provider ledger and a read-only MongoDB observer.

## Specifications

The authoritative requirements are documented in:

- [Behavioral Contract v1.1](specification/behavioral-contract.md)
- [Cross-Package Architecture Decisions v1.0](specification/architecture-decisions.md)
- [Candidate Implementation Instructions](specification/candidate-instructions.md)

The behavioral contract defines the required API behavior, state transitions, idempotency guarantees, persistence requirements, and test-only interfaces.

## Requirements

- Node.js 24 LTS
- npm 11
- MongoDB Atlas deployment supporting transactions (replica set)
- Environment configuration based on the root `.env.example`

The evaluator, Reference Backend, and Mock Provider use separate package configurations. Install dependencies from the repository root:

```bash
npm install
```

Create a local `.env` file from `.env.example` and configure the required MongoDB connection strings, test secret, provider URL, and provider tokens.

Never include real credentials or `.env` files in a submission archive.

## Running the Evaluation

Run the benchmark from the Evaluator package:

```bash
cd evaluator
npm start
```

The Evaluator starts the Mock Provider and the selected backend as separate processes, runs all six scenarios, performs cleanup, and generates JSON and Markdown reports.

The evaluation target is selected through `EVALUATOR_TARGET`:

- `reference` — runs the Reference Backend as a baseline.
- `candidate` — runs the Candidate Starter implementation.

The Candidate Starter is intentionally infrastructure-only. It must first be implemented according to the behavioral contract before it can be evaluated as a candidate solution.

The evaluator configuration and required environment variables are documented in `.env.example` and the package configuration.

## Results and Reports

Each scenario produces individual checks and a result summary.

The Evaluator generates:

- A JSON report containing structured scenario results.
- A Markdown report suitable for inspection and sharing.

The benchmark evaluates the selected implementation against observable outcomes and persisted state. A successful Reference Backend run validates the benchmark against the reference implementation; it does not represent an AI model's score.

## Reproducibility and Isolation

Each evaluation uses unique run identifiers to isolate data and provider operations.

The evaluator controls deterministic provider outcomes and synchronization gates instead of relying on arbitrary timing delays. Candidate processes are launched with an explicit environment-variable allowlist. Independent database observation and provider-ledger inspection help detect incorrect implementations that might otherwise appear successful from HTTP responses alone.

## Security

- Real environment files and credentials must not be included in source archives.
- The candidate receives only the environment variables required to run and communicate with the Mock Provider.
- Provider administration credentials and independent database observer credentials remain evaluator-side.
- Test-only endpoints are protected by a benchmark secret.

## Project Goal

OrderGuard Eval aims to reveal whether AI coding models can reason about distributed operations, transactional consistency, idempotency, concurrency, and recovery from uncertain external side effects.

The goal is to measure reliable engineering behavior under realistic failure conditions—not just the ability to produce code that passes straightforward happy-path tests.

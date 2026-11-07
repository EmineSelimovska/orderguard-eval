# OrderGuard Eval — Evaluator

The Evaluator is the independent orchestration and verification component of OrderGuard Eval.

It launches the Mock Provider and the selected backend as separate processes, executes six benchmark scenarios, inspects independently observable state, and generates structured reports.

## Requirements

- Node.js 24 LTS
- npm 11
- A MongoDB Atlas deployment supporting transactions
- A valid root `.env` configuration

## Configuration

Create the root `.env` file using `.env.example` as a template.

The Evaluator loads configuration from the repository root `.env` file. No separate `.env` file is required inside the `evaluator/` directory.

The Evaluator requires the following environment variables:

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Candidate/Reference Backend MongoDB write connection |
| `OBSERVER_MONGODB_URI` | Independent read-only MongoDB observer connection |
| `BENCHMARK_TEST_SECRET` | Authentication for benchmark test endpoints |
| `MOCK_PROVIDER_CLIENT_TOKEN` | Restricted Mock Provider client credential |
| `EVALUATOR_MOCK_PROVIDER_ADMIN_TOKEN` | Evaluator-only Mock Provider administration credential |
| `MOCK_PROVIDER_URL` | Local Mock Provider URL (default: `http://127.0.0.1:4001`) |
| `CANDIDATE_PORT` | Backend port (default: `3100`) |
| `PROVIDER_PORT` | Mock Provider port (default: `4001`) |
| `EVALUATOR_TARGET` | Backend to evaluate: `reference` or `candidate` |

The provider URL must use a local HTTP address and its port must match `PROVIDER_PORT`.

Do not commit or distribute the real `.env` file. Never provide evaluator administration credentials or observer credentials to the candidate process.

## Install Dependencies

From the repository root:

```bash
npm install
```

## Run the Evaluation

From the Evaluator directory:

```bash
cd evaluator
npm start
```

The Evaluator:

1. Loads and validates configuration.
2. Starts the Mock Provider.
3. Starts the selected backend as a separate process.
4. Creates isolated run identifiers for each scenario.
5. Executes all six benchmark scenarios.
6. Inspects backend responses, persisted MongoDB state, and the independent provider ledger.
7. Performs run-scoped cleanup.
8. Generates JSON and Markdown reports.

## Evaluation Targets

Select the backend using `EVALUATOR_TARGET` in the root `.env` file.

### Reference Backend

```env
EVALUATOR_TARGET=reference
```

Runs the reference implementation to validate the benchmark infrastructure and expected behavior.

### Candidate Backend

```env
EVALUATOR_TARGET=candidate
```

Runs the Candidate Starter implementation.

The Candidate Starter is intentionally infrastructure-only. An AI coding model must implement the behavioral contract before it can be meaningfully evaluated.

## Benchmark Scenarios

| # | Scenario | Main behavior tested |
|---|---|---|
| 1 | Duplicate Order Prevention | Concurrent idempotent order creation |
| 2 | Inventory Race Condition | Atomic inventory reservation |
| 3 | Duplicate Payment Webhook | Idempotent webhook processing |
| 4 | Payment Timeout and Retry | Reconciliation of uncertain payment outcomes |
| 5 | Cancellation vs. Payment Race | Cancellation consistency and refund compensation |
| 6 | Persistence After Restart | Durable state across process restarts |

## Reports

Reports are written to:

```text
evaluator/reports/
```

Each evaluation produces:

- A JSON report with structured scenario results and individual checks.
- A Markdown report with a human-readable summary.

Report filenames include a timestamp to distinguish evaluation runs.

## Independent Verification

The Evaluator uses multiple evidence sources:

- Public HTTP API responses.
- Candidate-reported test observations.
- Independent read-only MongoDB observations.
- Mock Provider charge and refund ledger.

Candidate-reported observations are not treated as authoritative. The Evaluator independently verifies persisted state and provider-side effects.

The candidate process does not receive Mock Provider administration credentials or the independent database observer credentials.

## Expected Baseline

The Reference Backend successfully completed all six benchmark scenarios, passing 86 out of 86 checks in the recorded validation run.

This result validates the current benchmark and reference implementation. It is not an AI model evaluation result.

## Important Notes

- Each scenario uses a unique run identifier.
- Provider outcomes and operation gates are controlled by the Evaluator.
- Tests use explicit synchronization rather than arbitrary random sleeps.
- Run-scoped cleanup prevents data from one evaluation from affecting another.
- The Reference Backend is a validation baseline, not an AI-generated candidate result.

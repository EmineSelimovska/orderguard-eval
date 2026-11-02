# OrderGuard Eval Candidate Implementation Instructions

Implement the required behavior in this Candidate Starter snapshot according to [Behavioral Contract v1.1](behavioral-contract.md) and the shared interfaces in [Cross-Package Architecture Decisions v1.0](architecture-decisions.md).

- Implement the public order, inventory, payment-attempt, cancellation, webhook, and test-only endpoints and their specified observable behavior.
- Keep this implementation within the Candidate Starter. Do not import or copy Reference Backend business logic.
- Use only the deterministic mock payment provider protocol. Do not integrate real payment services or allow public business requests to choose provider outcomes.
- Preserve run isolation, idempotency, required data fields, stable provider keys, and the contract's state and invariant requirements.
- Read test-only credentials only to protect test endpoints. Never log credentials or forward `BENCHMARK_TEST_SECRET` to the provider.
- Follow the runtime and installation versions supplied with this candidate archive. Do not change the public contract or evaluator/provider control interfaces.
- Do not rely on candidate-only synchronization hooks. The Evaluator controls requests and provider outcomes externally.

The Evaluator supplies runtime configuration as process environment variables. The candidate receives only its database write URI, test endpoint secret, provider URL, and restricted provider client token, in addition to `NODE_ENV` and `PORT`. It does not receive provider administration/ledger credentials or the Evaluator's read-only database observer credential.

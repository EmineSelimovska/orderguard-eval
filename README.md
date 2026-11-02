# orderguard-eval
A reproducible benchmark for evaluating AI coding models on reliable e-commerce order processing.

## Behavioral contract

The authoritative Reference Backend and candidate behavior requirements are documented in [Behavioral Contract v1.1](specification/behavioral-contract.md).

Cross-package integration boundaries, independent database observation, the mock-provider protocol, runtime policy, and reproducible candidate archives are defined in [Cross-Package Architecture Decisions v1.0](specification/architecture-decisions.md). Candidate implementation instructions are in [specification/candidate-instructions.md](specification/candidate-instructions.md).

## Workspace packages

- `reference-backend/` contains the minimal Express/Mongoose reference service. Benchmark business logic is not implemented yet.
- `candidate-starter/` contains a separate infrastructure-only Node.js package. Candidates are expected to implement the behavior defined by the contract in a later phase.
- `evaluator/` is a separate black-box evaluator scaffold. Scenario tests, scoring, provider simulation, and candidate orchestration are planned for later phases.

Install workspace dependencies from the repository root with `npm install`. Use these root commands:

```text
npm run start:reference
npm run dev:reference
npm run start:candidate
npm run start:evaluator
npm run test:reference
npm run test:evaluator
npm test
```

The Candidate Starter is private and is not published to npm. Benchmark releases will distribute it as an immutable, versioned source archive with the public contract, candidate instructions, and candidate-specific lock information. The root package and lockfile orchestrate the monorepo. Configure `MONGODB_URI` through the local ignored `.env` file or the process environment; never commit credentials.

# MongoDB Atlas Capability Verification

**Phase:** 3.6 — Read-only first
**Checked:** 2026-11-02
**Scope:** Atlas connection/topology, transaction readiness, unique-index compatibility, and evaluator observer permissions. No application, package, dependency, index, role, or database configuration was changed. The approved temporary transaction collection was created and dropped; its absence was verified.

## Verified facts

### Connection and topology — VERIFIED

- The candidate and Reference Backend both call `mongoose.connect(uri)` with `uri` defaulting to `process.env.MONGODB_URI`; neither specifies `dbName`. The package servers load the repository `.env` when present, otherwise the package-local `.env`. No `.env` values were read or displayed directly.
- The package manifests require Mongoose `^9.11.4`. `npm ls mongoose mongodb --all --depth=2` reported Mongoose **9.11.4** and its installed MongoDB Node.js driver **7.7.0**. The driver is currently transitive; no dependency was added.
- A new read-only probe, [`atlas-topology-diagnostic.js`](./atlas-topology-diagnostic.js), was run with `node specification\atlas-topology-diagnostic.js`. It loads the configured URI in memory and does not print it, hostnames, or credentials.
- The live check selected **`orderguard_eval`** and confirmed the expected database. The URI scheme was identified in memory as **standard `mongodb://`**, not SRV.
- `hello` returned a `setName` (redacted in output), no `msg`, `isWritablePrimary: true`, three hosts (hostnames redacted), and no `configsvr` field. The observed topology is a **three-member, unsharded replica set**, not a sharded cluster through `mongos`. `listShards` was not applicable and was not called.
- `buildInfo` reported MongoDB server version **8.0.36**.
- The diagnostic used no data reads or writes; it called topology/build metadata commands only.

### Transaction capability — VERIFIED

- MongoDB's current documentation describes multi-document transactions for replica sets and sharded clusters.
- The owner-approved diagnostic was run against a uniquely named temporary collection, `__orderguard_txn_probe_owner_20261102_165823`.
- The commit transaction completed; both committed records were visible outside the transaction.
- The abort transaction completed; the aborted record was absent outside the transaction.
- The script checked the collection contents before cleanup, dropped the temporary collection, and confirmed through `listCollections` that it no longer existed. `cleanupVerified` was `true`; process exit code was `0`.
- No transaction test errors or manual recovery actions were reported. The diagnostic printed its pre-write recovery instruction as a safeguard.

### Unique-index compatibility

The behavioral contract proposes the following unique keys in [behavioral-contract.md](./behavioral-contract.md):

| Entity | Proposed unique key |
|---|---|
| Product / Inventory | `(runId, sku)` |
| Order | `(runId, idempotencyKey)` |
| Payment | `(runId, orderId)` and `(runId, operationKey)` |
| Processed webhook event | `(runId, eventId)` |

The verified deployment is a three-member, unsharded replica set. The proposed unique compound keys are topology-compatible on unsharded collections. A read-only inspection found only the `products` collection, with only the default `_id_` index:

| Collection | Indexes found | Required-index status |
|---|---|---|
| `products` | `{ _id: 1 }` (`_id_`) | Required unique `{ runId: 1, sku: 1 }` is **not present**; cleanup index `{ runId: 1, updatedAt: 1 }` is also not present. |
| Orders | Collection not present | Required indexes cannot yet be verified. |
| Payments | Collection not present | Required indexes cannot yet be verified. |
| Processed webhook events | Collection not present | Required indexes cannot yet be verified. |

No existing index found conflicts with the proposed definitions. Index readiness is **not verified**: the required product index is absent, and the other entity collections do not exist. No index was created, modified, or dropped.

### Observer requirements

[architecture-decisions.md](./architecture-decisions.md) documents the observer policy: a dedicated read-only MongoDB identity scoped to `orderguard_eval` (prefer the built-in `read` role); `OBSERVER_MONGODB_URI` available only to the Evaluator and excluded from candidate processes; protected credential provisioning and rotation; and verification of collection discovery, run-scoped required-field reads, denied writes, and safe setup failure for missing or invalid credentials.

| Observer requirement | Status |
|---|---|
| Actual dedicated observer identity is provisioned | **NOT VERIFIED** |
| Actual read permissions and absence of write/admin permissions | **NOT VERIFIED** |
| Protected provisioning and rotation performed | **NOT VERIFIED**; procedure is documented, but actual setup is unverified. |
| Evaluator-only credential delivery and candidate-process isolation | **NOT VERIFIED**; documented policy only, not implemented or runtime-tested. |
| Required observer reads, denied write, and missing/invalid-credential handling | **NOT VERIFIED**; documented future verification requirements only. |

## Inferences

- A real transaction commit and abort were verified for the diagnostic identity on the target database. This does not verify application transaction workflows or other identities.
- The currently observed unsharded topology imposes no shard-key restriction on the proposed unique indexes. This does not establish that the indexes exist or are ready.
- An Atlas database user's built-in **`read` role scoped to `orderguard_eval`** is the simplest least-privilege observer role likely to cover collection discovery and reads. A custom role, if required, should grant only `listCollections` on that database and `find` on the benchmark collections. Do not grant `readAnyDatabase`, `readWrite`, `dbAdmin`, or cluster-monitoring roles to the observer for its stated job.
- An unsharded replica-set design is the simpler and safer choice for this benchmark's run-scoped data and uniqueness requirements. Sharding adds no demonstrated benefit here.

## Unverified assumptions

- The probe connected using `MONGODB_URI`; it did not inspect the identity or prove that a distinct `OBSERVER_MONGODB_URI` exists.
- The evaluator observer identity, effective permissions, protected provisioning/rotation, credential isolation, and required runtime checks have not been verified.
- The read-only inspection found only `products` and its `_id_` index. Required application indexes are not ready/present based on this evidence; order, payment, and processed-webhook indexes cannot be checked until those collections exist.
- The topology result is a point-in-time check. Atlas configuration could change after this report.
- The additional contract requirement “unique provider reference when present” does not specify the exact indexed fields or uniqueness scope; its exact index shape cannot be evaluated from the contract alone.

## Blockers

1. **Observer prerequisites remain unresolved:** actual identity, permissions, credential lifecycle, and evaluator isolation are not verified.
2. **Application index prerequisites remain unresolved:** the required products unique index is absent, and order, payment, and processed-webhook collections/indexes do not yet exist.
3. **Phase 3.6 is not fully complete.** Infrastructure topology and diagnostic transaction capability are verified, but application indexes and an independently credentialed, read-only evaluator observer must be implemented/provisioned and verified later.

## Recommended decisions

1. Keep benchmark collections unsharded on the verified replica set unless scale requirements change.
2. Provision the observer separately with only database-scoped read access to `orderguard_eval`. Give it collection discovery and `find` access, but no write/index/admin privileges. Define and verify provisioning/rotation and evaluator-only secret injection; ensure candidate processes cannot inherit observer credentials.
3. Keep identities separated: candidate runtime `MONGODB_URI` is write-scoped and candidate-only; Reference Backend uses a separate runtime identity; evaluator observer credentials are read-only and available only to the observer component; evaluator control credentials remain separate; mock-provider client and provider-admin/ledger credentials remain distinct. Do not pass observer, provider-admin, or evaluator-control credentials to the candidate.
4. If collections are ever sharded, select a deliberate shared shard-key strategy before sharding. A range shard key beginning with `{ runId: 1 }` on every affected collection would be a candidate because each proposed unique index already begins with `runId`; validate distribution and workload before adopting it. MongoDB requires a sharded unique index to be the shard key or have the shard key as a prefix, and unique hashed indexes are not allowed. Revisit any uniqueness requirement whose scope is global across runs.
5. Before benchmark runs, implement and verify required application indexes and the independent observer. Transaction capability is verified only for the diagnostic identity and target database, not for other application workflows or credentials.

## Diagnostic commands and recorded evidence

### Read-only topology check

The topology probe was run from the repository root with:

```powershell
node specification\atlas-topology-diagnostic.js
```

The probe reads the configured `MONGODB_URI` without displaying it. It reports the selected database, URI format (scheme only), MongoDB version, relevant `hello` fields with host values redacted, and shard count only if `listShards` is applicable and permitted. An authorization failure is reported by code without exposing connection details.

### Transaction capability test — executed with owner approval

The gated script is [`atlas-transaction-diagnostic.js`](./atlas-transaction-diagnostic.js). It ran with owner approval against `orderguard_eval` using the one-time collection `__orderguard_txn_probe_owner_20261102_165823`. Before collection creation, it printed the recovery instruction. The transaction assertions and cleanup verification succeeded.

Recorded command (already executed):

```powershell
node specification\atlas-transaction-diagnostic.js --owner-approved --collection=__orderguard_txn_probe_owner_20261102_165823
```

The script created the empty temporary collection with majority write concern. It committed two diagnostic documents (`_id` values `committed-a` and `committed-b`) in the first transaction, then wrote `_id: "aborted"` in a separate transaction and explicitly aborted it. It verified both committed documents were visible and the aborted document was absent. Before automatic cleanup, it read the temporary collection and dropped it only if every document had only an `_id` field and that `_id` was one of `committed-a`, `committed-b`, or `aborted`. If any unexpected document or field existed, cleanup would stop and preserve the collection for inspection. It did not use a benchmark collection or query benchmark data.

The recovery command is printed before any write, so it remains available if the process is interrupted before `finally` completes. In an already-authenticated `mongosh` session, it inspects the exact collection and drops it only when its contents match the allowed diagnostic record shape; unexpected records are preserved:

```javascript
const d = db.getSiblingDB("orderguard_eval");
const n = "__orderguard_txn_probe_owner_20261102_165823";
if (d.getCollectionNames().includes(n)) {
  const allowed = new Set(["committed-a", "committed-b", "aborted"]);
  const docs = d.getCollection(n).find({}).toArray();
  const safeToDrop = docs.every((doc) =>
    Object.keys(doc).length === 1 && allowed.has(doc._id)
  );
  printjson({ collection: n, documents: docs, safeToDrop });
  if (safeToDrop) {
    printjson(d.dropCollection(n));
  } else {
    print("Unexpected records found; collection preserved for manual inspection.");
  }
}
```

Expected evidence on success:

```json
{
  "transaction": {
    "committedWritesVisible": true,
    "abortedWriteAbsent": true
  },
  "transactionError": null,
  "cleanupVerified": true,
  "cleanupError": null
}
```

The output reported `committedWritesVisible: true`, `abortedWriteAbsent: true`, and `cleanupVerified: true`; process exit code was `0`. No transaction errors or recovery actions were reported. This verifies the actual diagnostic transaction path on this database, not every application transaction workflow.

## Documentation sources

- [MongoDB transactions](https://www.mongodb.com/docs/manual/core/transactions/)
- [Unique indexes and sharded-cluster restrictions](https://www.mongodb.com/docs/manual/core/index-unique/)
- [`listShards` command](https://www.mongodb.com/docs/manual/reference/command/listShards/)
- [MongoDB built-in roles](https://www.mongodb.com/docs/manual/reference/built-in-roles/#read)
- [Atlas database users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/)

import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const specificationDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(specificationDirectory, '..');
const repositoryEnv = resolve(repositoryRoot, '.env');
const candidateEnv = resolve(repositoryRoot, 'candidate-starter', '.env');
dotenv.config({
  path: existsSync(repositoryEnv) ? repositoryEnv : candidateEnv,
  quiet: true,
});

const requestedCollectionName = process.argv
  .find((argument) => argument.startsWith('--collection='))
  ?.slice('--collection='.length);
const collectionName = requestedCollectionName
  ?? `__orderguard_txn_probe_${randomUUID().replaceAll('-', '')}`;
const recoveryCommand = `const d = db.getSiblingDB("orderguard_eval");
const n = "${collectionName}";
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
}`;

function printRecoveryInstruction() {
  console.error(
    `Recovery safeguard for ${collectionName}: if this process is interrupted, ` +
    'inspect this collection in an authenticated mongosh session. Drop it only ' +
    'if the command confirms safeToDrop: true, otherwise preserve it:\n' +
    recoveryCommand,
  );
}

if (!process.argv.includes('--owner-approved')) {
  console.error('Transaction probe not run: explicit owner approval is required.');
  process.exitCode = 2;
} else if (!/^__orderguard_txn_probe_[A-Za-z0-9_]{1,48}$/.test(collectionName)) {
  console.error('Transaction probe not run: invalid diagnostic collection name.');
  process.exitCode = 2;
} else if (!process.env.MONGODB_URI) {
  console.error('Transaction probe not run: MONGODB_URI is not configured.');
  process.exitCode = 1;
} else {
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });
  let database;
  let collectionCreated = false;
  let collectionMayExist = false;
  let collectionAbsenceVerified = false;
  let testResult;
  let testError;
  let cleanupError;

  try {
    await client.connect();
    database = client.db();

    if (database.databaseName !== 'orderguard_eval') {
      throw new Error('Configured database is not orderguard_eval');
    }

    const alreadyExists = await database
      .listCollections({ name: collectionName }, { nameOnly: true })
      .hasNext();

    if (alreadyExists) {
      throw new Error('Diagnostic collection name collision');
    }

    printRecoveryInstruction();
    collectionMayExist = true;
    await database.createCollection(collectionName, {
      writeConcern: { w: 'majority' },
    });
    collectionCreated = true;

    const collection = database.collection(collectionName, {
      readConcern: { level: 'majority' },
    });
    const session = client.startSession();

    try {
      const transactionOptions = {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      };

      session.startTransaction(transactionOptions);
      await collection.insertMany(
        [{ _id: 'committed-a' }, { _id: 'committed-b' }],
        { session },
      );
      await session.commitTransaction();

      session.startTransaction(transactionOptions);
      await collection.insertOne({ _id: 'aborted' }, { session });
      await session.abortTransaction();

      const committedA = await collection.findOne({ _id: 'committed-a' });
      const committedB = await collection.findOne({ _id: 'committed-b' });
      const aborted = await collection.findOne({ _id: 'aborted' });
      testResult = {
        committedWritesVisible: Boolean(committedA && committedB),
        abortedWriteAbsent: aborted === null,
      };
    } finally {
      await session.endSession();
    }
  } catch (error) {
    testError = error.codeName ?? error.code ?? 'diagnostic failure';
  } finally {
    if (collectionCreated) {
      try {
        const collection = database.collection(collectionName, {
          readConcern: { level: 'majority' },
        });
        const documents = await collection.find({}).toArray();
        const allowedIds = new Set(['committed-a', 'committed-b', 'aborted']);
        const containsOnlyDiagnosticRecords = documents.every((document) => (
          Object.keys(document).length === 1
          && Object.hasOwn(document, '_id')
          && allowedIds.has(document._id)
        ));

        if (!containsOnlyDiagnosticRecords) {
          cleanupError = 'unexpected records found; collection preserved';
          printRecoveryInstruction();
        } else {
          await database.dropCollection(collectionName, {
            writeConcern: { w: 'majority' },
          });
        }

        const remains = await database
          .listCollections({ name: collectionName }, { nameOnly: true })
          .hasNext();

        if (remains) {
          cleanupError ??= 'temporary collection still exists after cleanup';
          printRecoveryInstruction();
        } else {
          collectionAbsenceVerified = true;
        }
      } catch (error) {
        cleanupError ??= error.codeName ?? error.code ?? 'cleanup failure';
        printRecoveryInstruction();
      }
    } else if (collectionMayExist) {
      cleanupError = 'collection creation outcome uncertain; inspect manually';
      printRecoveryInstruction();
    }

    try {
      await client.close();
    } catch (error) {
      cleanupError ??= error.codeName ?? error.code ?? 'client close failure';
    }
  }

  const result = {
    transaction: testResult ?? { verified: false },
    transactionError: testError,
    cleanupVerified: collectionCreated
      && collectionAbsenceVerified
      && cleanupError === undefined,
    cleanupError,
  };

  if (cleanupError) {
    result.temporaryCollectionForManualCleanup = collectionName;
  }

  console.log(JSON.stringify(result, null, 2));

  if (
    testError
    || !testResult?.committedWritesVisible
    || !testResult?.abortedWriteAbsent
    || !result.cleanupVerified
  ) {
    process.exitCode = 1;
  }
}

import dotenv from 'dotenv';
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

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error('Atlas topology check not run: MONGODB_URI is not configured.');
  process.exitCode = 1;
} else {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });

  try {
    await client.connect();

    const database = client.db();
    const admin = database.admin();
    const hello = await admin.command({ hello: 1 });
    const buildInfo = await admin.command({ buildInfo: 1 });
    const topology = hello.msg === 'isdbgrid'
      ? 'sharded cluster via mongos'
      : hello.setName
        ? 'replica set'
        : 'standalone or unrecognized topology';
    const connectionFormat = uri.startsWith('mongodb+srv://')
      ? 'SRV'
      : uri.startsWith('mongodb://')
        ? 'standard'
        : 'unrecognized';

    const result = {
      database: database.databaseName,
      databaseIsOrderguardEval: database.databaseName === 'orderguard_eval',
      connectionFormat,
      serverVersion: buildInfo.version,
      topology,
      hello: {
        setName: hello.setName ? '<redacted>' : null,
        msg: hello.msg ?? null,
        isWritablePrimary: hello.isWritablePrimary ?? null,
        hostsCount: Array.isArray(hello.hosts) ? hello.hosts.length : null,
        hosts: Array.isArray(hello.hosts) ? '<redacted>' : null,
        configsvr: hello.configsvr ?? null,
      },
    };

    if (hello.msg === 'isdbgrid') {
      try {
        const shardInfo = await admin.command({ listShards: 1 });
        result.shards = {
          permitted: true,
          count: Array.isArray(shardInfo.shards) ? shardInfo.shards.length : null,
        };
      } catch (error) {
        result.shards = {
          permitted: false,
          errorCode: error.code ?? null,
          errorCodeName: error.codeName ?? null,
        };
      }
    } else {
      result.shards = { applicable: false };
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      'Atlas topology check failed; connection details suppressed.',
      error.codeName ?? error.code ?? 'unknown error',
    );
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

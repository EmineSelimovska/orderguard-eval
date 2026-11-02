import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryEnv = resolve(packageRoot, '..', '.env');
const localEnv = resolve(packageRoot, '.env');
dotenv.config({ path: existsSync(repositoryEnv) ? repositoryEnv : localEnv });

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
let server;

try {
  await connectDatabase();
  server = app.listen(port, () => {
    console.log(`OrderGuard Eval reference backend listening on port ${port}`);
  });
} catch {
  console.error('Reference backend startup failed: could not connect to MongoDB Atlas');
  process.exitCode = 1;
  await disconnectDatabase();
}

async function shutdown() {
  if (server) {
    await new Promise((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
  await disconnectDatabase();
}

process.once('SIGINT', () => shutdown().finally(() => process.exit()));
process.once('SIGTERM', () => shutdown().finally(() => process.exit()));

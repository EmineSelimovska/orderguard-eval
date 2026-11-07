
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
let server;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

try {
  await connectDatabase();

  server = app.listen(port, '127.0.0.1', () => {
    console.log(`Candidate backend listening on port ${port}`);
  });
} catch {
  console.error('Candidate startup failed; connection details suppressed');
  await disconnectDatabase();
  process.exitCode = 1;
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

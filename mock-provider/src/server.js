import { createProviderApp } from './app.js';

const port = Number(process.env.PORT ?? 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const app = createProviderApp();
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Mock provider listening on 127.0.0.1:${port}`);
});

async function shutdown() {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

process.once('SIGINT', () => shutdown().finally(() => process.exit()));
process.once('SIGTERM', () => shutdown().finally(() => process.exit()));
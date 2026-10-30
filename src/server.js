import 'dotenv/config';
import express from 'express';
import { connectDatabase, disconnectDatabase } from './config/database.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

let server;

try {
  await connectDatabase();
  server = app.listen(port, () => {
    console.log(`OrderGuard Eval service listening on port ${port}`);
  });
} catch {
  console.error('Startup failed: could not connect to MongoDB Atlas');
  process.exitCode = 1;
  await disconnectDatabase();
}

async function shutdown() {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await disconnectDatabase();
}

process.once('SIGINT', () => shutdown().finally(() => process.exit()));
process.once('SIGTERM', () => shutdown().finally(() => process.exit()));

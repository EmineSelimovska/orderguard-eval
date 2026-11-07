import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  startNodeService,
  waitForPort,
  stopNodeService,
} from '../process/process-manager.js';

import { buildProviderEnv } from '../config/index.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '../../..');

export async function startProvider(config) {
  const service = await startNodeService({
    name: 'Mock Provider',
    scriptPath: path.join(projectRoot, 'mock-provider/src/server.js'),
    cwd: path.join(projectRoot, 'mock-provider'),
    env: buildProviderEnv(config),
    allowedEnv: [
      'NODE_ENV',
      'PORT',
      'MOCK_PROVIDER_CLIENT_TOKEN',
      'MOCK_PROVIDER_ADMIN_TOKEN',
    ],
  });

  try {
    await waitForPort(service, config.provider.port, {
      timeoutMs: config.runtime.startupTimeoutMs,
    });

    return service;
  } catch (error) {
    await stopNodeService(service);
    throw error;
  }
}

export async function stopProvider(service, config) {
  await stopNodeService(
    service,
    config.runtime.shutdownTimeoutMs,
  );
}
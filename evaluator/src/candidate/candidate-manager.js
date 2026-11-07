
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startNodeService,
  waitForPort,
  stopNodeService,
} from '../process/process-manager.js';
import { buildCandidateEnv } from '../config/index.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '../../..');

export async function startCandidate(config) {
  const isReference = config.candidate.target === 'reference';
  const workspace = isReference ? 'reference-backend' : 'candidate-starter';

  const service = await startNodeService({
    name: isReference ? 'Reference Backend' : 'Candidate',
    scriptPath: path.join(projectRoot, workspace, 'src/server.js'),
    cwd: path.join(projectRoot, workspace),
    env: buildCandidateEnv(config),
    allowedEnv: [
      'NODE_ENV',
      'PORT',
      'MONGODB_URI',
      'BENCHMARK_TEST_SECRET',
      'MOCK_PROVIDER_URL',
      'MOCK_PROVIDER_CLIENT_TOKEN',
    ],
  });

  try {
    await waitForPort(service, config.candidate.port, {
      timeoutMs: config.runtime.startupTimeoutMs,
    });

    return service;
  } catch (error) {
    await stopNodeService(service);
    throw error;
  }
}

export async function stopCandidate(service, config) {
  await stopNodeService(service, config.runtime.shutdownTimeoutMs);
}

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeAtlasIntegrationEnvironment,
  loadLocalEnvironment,
} from './atlas-integration-safety.js';

loadLocalEnvironment();

if (process.env.NODE_ENV && process.env.NODE_ENV !== 'test') {
  throw new Error(
    'Atlas integration runner refused to run outside an unset or test NODE_ENV',
  );
}

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

assertSafeAtlasIntegrationEnvironment({ requireOptIn: false });
process.env.ORDERGUARD_ATLAS_INTEGRATION = '1';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jestPath = resolve(packageRoot, '..', 'node_modules', 'jest', 'bin', 'jest.js');
const result = spawnSync(process.execPath, [
  '--experimental-vm-modules',
  jestPath,
  '--runInBand',
  '--config',
  'jest.config.js',
  '--runTestsByPath',
  'tests/payment-service-atlas.integration.test.js',
], {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw new Error('Could not start the Atlas integration test runner', {
    cause: result.error,
  });
}

process.exitCode = result.status ?? 1;

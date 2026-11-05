import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryEnv = resolve(packageRoot, '..', '.env');
const localEnv = resolve(packageRoot, '.env');

export function loadLocalEnvironment() {
  dotenv.config({
    path: existsSync(repositoryEnv) ? repositoryEnv : localEnv,
    quiet: true,
  });
}

function parseMongoUri(uri) {
  const match = uri.match(
    /^mongodb(?:\+srv)?:\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/i,
  );
  if (!match) {
    return null;
  }

  const authority = match[1];
  const hosts = authority
    .slice(authority.lastIndexOf('@') + 1)
    .split(',')
    .map((entry) => entry.replace(/^.*@/, ''))
    .map((entry) => entry.replace(/:\d+$/, '').toLowerCase());
  let databaseName;
  try {
    databaseName = decodeURIComponent(match[2] ?? '');
  } catch {
    return null;
  }

  const options = new URLSearchParams(match[3] ?? '');
  return {
    isAtlas: hosts.length > 0
      && hosts.every((host) => host.endsWith('.mongodb.net')),
    databaseName,
    optionDatabaseName: options.get('dbName'),
  };
}

export function assertSafeAtlasIntegrationEnvironment({
  requireOptIn = true,
} = {}) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Atlas integration tests require NODE_ENV=test');
  }
  if (
    requireOptIn
    && process.env.ORDERGUARD_ATLAS_INTEGRATION !== '1'
  ) {
    throw new Error('Atlas integration tests require explicit opt-in');
  }

  const uri = process.env.MONGODB_URI;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('Atlas integration tests require the configured MongoDB URI');
  }

  const parsed = parseMongoUri(uri);
  if (
    !parsed
    || !parsed.isAtlas
    || parsed.databaseName !== 'orderguard_eval'
    || (
      parsed.optionDatabaseName !== null
      && parsed.optionDatabaseName !== 'orderguard_eval'
    )
  ) {
    throw new Error(
      'Atlas integration tests require an Atlas URI for the dedicated orderguard_eval database',
    );
  }
}

const REQUIRED_ENV = [
  'MONGODB_URI',
  'OBSERVER_MONGODB_URI',
  'BENCHMARK_TEST_SECRET',
  'MOCK_PROVIDER_CLIENT_TOKEN',
  'EVALUATOR_MOCK_PROVIDER_ADMIN_TOKEN',
];

function required(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }

  return value;
}

export function loadConfig() {
  for (const name of REQUIRED_ENV) {
    required(name);
  }

  const config = {
    candidate: {
      port: port('CANDIDATE_PORT', 3100),
      mongoUri: required('MONGODB_URI'),
      testSecret: required('BENCHMARK_TEST_SECRET'),
      providerUrl: process.env.MOCK_PROVIDER_URL ?? 'http://127.0.0.1:3200',
      providerClientToken: required('MOCK_PROVIDER_CLIENT_TOKEN'),
      target: process.env.EVALUATOR_TARGET ?? 'candidate',
    },

    provider: {
      port: port('PROVIDER_PORT', 3200),
      clientToken: required('MOCK_PROVIDER_CLIENT_TOKEN'),
      adminToken: required('EVALUATOR_MOCK_PROVIDER_ADMIN_TOKEN'),
    },

    observer: {
      mongoUri: required('OBSERVER_MONGODB_URI'),
    },

    runtime: {
      nodeEnv: 'test',
      startupTimeoutMs: 15000,
      shutdownTimeoutMs: 5000,
    },
  };

  if (!['candidate', 'reference'].includes(config.candidate.target)) {
  throw new Error('EVALUATOR_TARGET must be candidate or reference');
}

  const providerUrl = new URL(config.candidate.providerUrl);

  if (
    providerUrl.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(providerUrl.hostname)
  ) {
    throw new Error('Mock Provider must use a local HTTP address');
  }

  if (Number(providerUrl.port || 80) !== config.provider.port) {
    throw new Error('MOCK_PROVIDER_URL port must match PROVIDER_PORT');
  }

  return Object.freeze(config);
}

export function buildCandidateEnv(config) {
  return {
    NODE_ENV: config.runtime.nodeEnv,
    PORT: String(config.candidate.port),
    MONGODB_URI: config.candidate.mongoUri,
    BENCHMARK_TEST_SECRET: config.candidate.testSecret,
    MOCK_PROVIDER_URL: config.candidate.providerUrl,
    MOCK_PROVIDER_CLIENT_TOKEN: config.candidate.providerClientToken,
  };
}

export function buildProviderEnv(config) {
  return {
    NODE_ENV: 'test',
    PORT: String(config.provider.port),
    MOCK_PROVIDER_CLIENT_TOKEN: config.provider.clientToken,
    MOCK_PROVIDER_ADMIN_TOKEN: config.provider.adminToken,
  };
}
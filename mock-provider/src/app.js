import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createMockProvider, MockProviderError } from './provider.js';

function errorBody(code, message) {
  return { error: { code, message } };
}

function hasExactFields(value, fields) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function matchesBearer(request, expectedToken) {
  const authorization = request.get('Authorization');
  if (typeof authorization !== 'string') {
    return 'missing';
  }
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) {
    return 'invalid';
  }
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
    ? 'valid'
    : 'invalid';
}

function protect(token, handler) {
  return (request, response, next) => {
    const result = matchesBearer(request, token);
    if (result === 'missing') {
      return response.status(401).json(errorBody('UNAUTHORIZED', 'Bearer credentials are required'));
    }
    if (result !== 'valid') {
      return response.status(403).json(errorBody('FORBIDDEN', 'Bearer credentials are invalid'));
    }
    return handler(request, response, next);
  };
}

function sendProviderError(response, error) {
  if (error?.transportLost) {
    response.destroy();
    return;
  }
  if (error instanceof MockProviderError) {
    if (error.responseBody) {
      response.status(error.status).json(error.responseBody);
      return;
    }
    response.status(error.status).json(errorBody(error.code, error.message));
    return;
  }
  response.status(503).json(errorBody(
    'SERVICE_UNAVAILABLE',
    'Mock provider is temporarily unavailable',
  ));
}

export function createProviderApp({
  clientToken = process.env.MOCK_PROVIDER_CLIENT_TOKEN,
  adminToken = process.env.MOCK_PROVIDER_ADMIN_TOKEN,
  provider = createMockProvider(),
} = {}) {
  if (typeof clientToken !== 'string' || clientToken.length === 0) {
    throw new TypeError('MOCK_PROVIDER_CLIENT_TOKEN is required');
  }
  if (typeof adminToken !== 'string' || adminToken.length === 0) {
    throw new TypeError('MOCK_PROVIDER_ADMIN_TOKEN is required');
  }
  if (!provider) {
    throw new TypeError('provider is required');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  app.post('/v1/charges', protect(clientToken, (request, response) => {
    if (!hasExactFields(request.body, ['runId', 'operationKey', 'amountMinor', 'currency'])) {
      return response.status(400).json(errorBody('INVALID_REQUEST', 'Charge request is invalid'));
    }
    provider.charge(
      request.body.runId,
      request.body.operationKey,
      request.body.amountMinor,
      request.body.currency,
    ).then((result) => {
      if (!response.destroyed) response.status(200).json(result);
    }).catch((error) => sendProviderError(response, error));
  }));

  app.post('/v1/refunds', protect(clientToken, (request, response) => {
    if (!hasExactFields(request.body, ['runId', 'refundOperationKey', 'originalOperationKey'])) {
      return response.status(400).json(errorBody('INVALID_REQUEST', 'Refund request is invalid'));
    }
    provider.refund(
      request.body.runId,
      request.body.refundOperationKey,
      request.body.originalOperationKey,
    ).then((result) => {
      if (!response.destroyed) response.status(200).json(result);
    }).catch((error) => sendProviderError(response, error));
  }));

  app.put(
    '/_control/v1/runs/:runId/operations/:operationKey',
    protect(adminToken, (request, response) => {
      const { runId, operationKey } = request.params;
      const fields = ['chargeOutcome', 'holdAt'];
      if (Object.hasOwn(request.body ?? {}, 'refundOutcome')) fields.push('refundOutcome');
      if (Object.hasOwn(request.body ?? {}, 'refundHoldAt')) fields.push('refundHoldAt');
      if (!hasExactFields(request.body, fields)) {
        return response.status(400).json(errorBody('INVALID_REQUEST', 'Operation plan is invalid'));
      }
      try {
        const result = provider.configureOperation(runId, operationKey, request.body);
        return response.status(result.status).json({ runId: result.runId, operationKey: result.operationKey });
      } catch (error) {
        return sendProviderError(response, error);
      }
    }),
  );

  app.post(
    '/_control/v1/runs/:runId/operations/:operationKey/release',
    protect(adminToken, (request, response) => {
      if (!hasExactFields(request.body, ['phase'])) {
        return response.status(400).json(errorBody('INVALID_REQUEST', 'Gate release request is invalid'));
      }
      try {
        const result = provider.releaseOperationGate(
          request.params.runId,
          request.params.operationKey,
          request.body.phase,
        );
        return response.status(200).json(result);
      } catch (error) {
        return sendProviderError(response, error);
      }
    }),
  );

  app.get('/_control/v1/runs/:runId/ledger', protect(adminToken, (request, response) => {
    try {
      return response.status(200).json(provider.getLedger(request.params.runId));
    } catch (error) {
      return sendProviderError(response, error);
    }
  }));

  app.delete('/_control/v1/runs/:runId', protect(adminToken, (request, response) => {
    try {
      if (!provider.clearRun(request.params.runId)) {
        return response.status(409).json(errorBody('RUN_BUSY', 'Provider run has unfinished operations'));
      }
      return response.status(204).end();
    } catch (error) {
      return sendProviderError(response, error);
    }
  }));

  app.use((error, _request, response, _next) => {
    if (error?.type === 'entity.parse.failed') {
      return response.status(400).json(errorBody('INVALID_REQUEST', 'Request body must be valid JSON'));
    }
    if (error?.type === 'entity.too.large') {
      return response.status(400).json(errorBody('INVALID_REQUEST', 'Request body is too large'));
    }
    return response.status(503).json(errorBody(
      'SERVICE_UNAVAILABLE',
      'Mock provider is temporarily unavailable',
    ));
  });

  app.use((_request, response) => response.status(404).json(errorBody('NOT_FOUND', 'Route was not found')));
  return app;
}
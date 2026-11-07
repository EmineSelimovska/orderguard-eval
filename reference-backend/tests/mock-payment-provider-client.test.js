import { jest } from '@jest/globals';
import { once } from 'node:events';
import {
  createMockPaymentProviderClient,
} from '../src/provider/mock-payment-provider-client.js';
import { createProviderApp } from '../../mock-provider/src/app.js';

const configuration = {
  url: 'http://127.0.0.1:4123/',
  token: 'restricted-client-token',
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

async function withProviderEnvironment(callback) {
  const previousUrl = process.env.MOCK_PROVIDER_URL;
  const previousToken = process.env.MOCK_PROVIDER_CLIENT_TOKEN;
  process.env.MOCK_PROVIDER_URL = configuration.url;
  process.env.MOCK_PROVIDER_CLIENT_TOKEN = configuration.token;
  try {
    await callback();
  } finally {
    if (previousUrl === undefined) delete process.env.MOCK_PROVIDER_URL;
    else process.env.MOCK_PROVIDER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.MOCK_PROVIDER_CLIENT_TOKEN;
    else process.env.MOCK_PROVIDER_CLIENT_TOKEN = previousToken;
  }
}

describe('mock payment provider HTTP client', () => {
  test('sends charge requests to the data plane with only the client credential', async () => {
    await withProviderEnvironment(async () => {
      const fetchImplementation = jest.fn().mockResolvedValue(response(200, {
        runId: 'run-client',
        operationKey: 'op-1',
        status: 'succeeded',
        providerReference: 'provider-charge-1',
      }));
      const client = createMockPaymentProviderClient({ fetchImplementation });

      await expect(client.charge('run-client', 'op-1', 2500, 'USD')).resolves.toMatchObject({
        status: 'succeeded',
        providerReference: 'provider-charge-1',
      });

      expect(fetchImplementation).toHaveBeenCalledWith(
        'http://127.0.0.1:4123/v1/charges',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer restricted-client-token',
          }),
          body: JSON.stringify({
            runId: 'run-client',
            operationKey: 'op-1',
            amountMinor: 2500,
            currency: 'USD',
          }),
        }),
      );
      expect(fetchImplementation.mock.calls[0][1].headers.Authorization)
        .not.toContain('ADMIN');
    });
  });

  test('maps the definite no-processing response without claiming a decline', async () => {
    await withProviderEnvironment(async () => {
      const client = createMockPaymentProviderClient({
        fetchImplementation: jest.fn().mockResolvedValue(response(504, {
          code: 'NOT_PROCESSED',
          runId: 'run-client',
          operationKey: 'op-1',
        })),
      });

      await expect(client.charge('run-client', 'op-1', 2500, 'USD'))
        .rejects.toMatchObject({ code: 'NOT_PROCESSED', status: 504, outcome: 'not_processed' });
    });
  });

  test('maps transport loss to an unknown provider result for same-key retry', async () => {
    await withProviderEnvironment(async () => {
      const client = createMockPaymentProviderClient({
        fetchImplementation: jest.fn().mockRejectedValue(new TypeError('socket closed')),
      });

      await expect(client.charge('run-client', 'op-1', 2500, 'USD'))
        .rejects.toMatchObject({ code: 'PROCESSED_RESPONSE_TIMEOUT', status: 504, outcome: 'unknown' });
    });
  });

  test('sends refunds through the data plane and preserves provider conflicts', async () => {
    await withProviderEnvironment(async () => {
      const fetchImplementation = jest.fn().mockResolvedValue(response(409, {
        error: { code: 'REFUND_NOT_ALLOWED', message: 'Original charge was not captured' },
      }));
      const client = createMockPaymentProviderClient({ fetchImplementation });

      await expect(client.refund('run-client', 'refund-1', 'op-1'))
        .rejects.toMatchObject({ code: 'REFUND_NOT_ALLOWED', status: 409 });
      expect(fetchImplementation).toHaveBeenCalledWith(
        'http://127.0.0.1:4123/v1/refunds',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer restricted-client-token',
          }),
          body: JSON.stringify({
            runId: 'run-client',
            refundOperationKey: 'refund-1',
            originalOperationKey: 'op-1',
          }),
        }),
      );
    });
  });

  test('completes charge and refund round trips against the standalone provider HTTP app', async () => {
    await withProviderEnvironment(async () => {
      const adminToken = 'provider-test-admin-token';
      const server = createProviderApp({
        clientToken: configuration.token,
        adminToken,
      }).listen(0, '127.0.0.1');
      await once(server, 'listening');
      process.env.MOCK_PROVIDER_URL = `http://127.0.0.1:${server.address().port}`;

      try {
        const planned = await fetch(
          `${process.env.MOCK_PROVIDER_URL}/_control/v1/runs/run-roundtrip/operations/op-roundtrip`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${adminToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ chargeOutcome: 'success', holdAt: null }),
          },
        );
        expect(planned.status).toBe(201);

        const client = createMockPaymentProviderClient();
        const charged = await client.charge('run-roundtrip', 'op-roundtrip', 2500, 'USD');
        expect(charged).toMatchObject({ status: 'succeeded', operationKey: 'op-roundtrip' });

        const refunded = await client.refund(
          'run-roundtrip',
          'refund-op-roundtrip',
          'op-roundtrip',
        );
        expect(refunded).toMatchObject({
          status: 'refunded',
          refundOperationKey: 'refund-op-roundtrip',
          originalOperationKey: 'op-roundtrip',
          amountMinor: 2500,
          currency: 'USD',
        });
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
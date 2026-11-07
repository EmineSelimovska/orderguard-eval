export class MockPaymentProviderClientError extends Error {
  constructor(code, status, message, { outcome } = {}) {
    super(message);
    this.name = 'MockPaymentProviderClientError';
    this.code = code;
    this.status = status;
    if (outcome) {
      this.outcome = outcome;
    }
  }
}

function clientConfiguration() {
  const baseUrl = process.env.MOCK_PROVIDER_URL;
  const clientToken = process.env.MOCK_PROVIDER_CLIENT_TOKEN;
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0
    || typeof clientToken !== 'string' || clientToken.length === 0) {
    throw new MockPaymentProviderClientError(
      'SERVICE_UNAVAILABLE',
      503,
      'Mock payment provider is not configured',
    );
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new MockPaymentProviderClientError(
      'SERVICE_UNAVAILABLE',
      503,
      'Mock payment provider URL is invalid',
    );
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new MockPaymentProviderClientError(
      'SERVICE_UNAVAILABLE',
      503,
      'Mock payment provider URL is invalid',
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    clientToken,
  };
}

function providerError(response, body) {
  if (response.status === 504 && body?.code === 'NOT_PROCESSED') {
    return new MockPaymentProviderClientError(
      'NOT_PROCESSED',
      504,
      'Charge was not processed',
      { outcome: 'not_processed' },
    );
  }
  if (response.status === 504) {
    return new MockPaymentProviderClientError(
      'PROCESSED_RESPONSE_TIMEOUT',
      504,
      'Provider response was lost',
      { outcome: 'unknown' },
    );
  }

  const code = body?.error?.code ?? body?.code ?? 'SERVICE_UNAVAILABLE';
  const message = response.status >= 500
    ? 'Mock payment provider is temporarily unavailable'
    : 'Mock payment provider rejected the operation';
  return new MockPaymentProviderClientError(code, response.status, message);
}

export function createMockPaymentProviderClient({
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('fetchImplementation must be a function');
  }

  async function request(path, body) {
    const { baseUrl, clientToken } = clientConfiguration();
    let response;
    try {
      response = await fetchImplementation(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new MockPaymentProviderClientError(
        'PROCESSED_RESPONSE_TIMEOUT',
        504,
        'Provider response was lost',
        { outcome: 'unknown' },
      );
    }

    let result;
    try {
      result = await response.json();
    } catch {
      if (response.status === 504) {
        throw providerError(response, null);
      }
      throw new MockPaymentProviderClientError(
        'PAYMENT_PROVIDER_INVALID_RESPONSE',
        502,
        'Mock payment provider returned an invalid response',
      );
    }

    if (!response.ok) {
      throw providerError(response, result);
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new MockPaymentProviderClientError(
        'PAYMENT_PROVIDER_INVALID_RESPONSE',
        502,
        'Mock payment provider returned an invalid response',
      );
    }
    return result;
  }

  return {
    charge(runId, operationKey, amountMinor, currency) {
      return request('/v1/charges', {
        runId,
        operationKey,
        amountMinor,
        currency,
      });
    },
    refund(runId, refundOperationKey, originalOperationKey) {
      return request('/v1/refunds', {
        runId,
        refundOperationKey,
        originalOperationKey,
      });
    },
  };
}

export const mockPaymentProviderClient = createMockPaymentProviderClient();
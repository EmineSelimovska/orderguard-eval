function createHeaders(adminToken) {
  return {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };
}

async function request(baseUrl, adminToken, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...createHeaders(adminToken),
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Provider control request failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export function createProviderControl(config) {
  const baseUrl = `http://127.0.0.1:${config.provider.port}`;
  const adminToken = config.provider.adminToken;

  return {
    async configureOperation(runId, operationKey, settings) {
      return request(
        baseUrl,
        adminToken,
        `/_control/v1/runs/${encodeURIComponent(runId)}/operations/${encodeURIComponent(operationKey)}`,
        {
          method: 'PUT',
          body: JSON.stringify(settings),
        },
      );
    },

    async releaseOperation(runId, operationKey, phase) {
      return request(
        baseUrl,
        adminToken,
        `/_control/v1/runs/${encodeURIComponent(runId)}/operations/${encodeURIComponent(operationKey)}/release`,
        {
          method: 'POST',
          body: JSON.stringify({ phase }),
        },
      );
    },

    async getLedger(runId) {
      return request(
        baseUrl,
        adminToken,
        `/_control/v1/runs/${encodeURIComponent(runId)}/ledger`,
        { method: 'GET' },
      );
    },

    async cleanupRun(runId) {
      return request(
        baseUrl,
        adminToken,
        `/_control/v1/runs/${encodeURIComponent(runId)}`,
        { method: 'DELETE' },
      );
    },
  };
}
export function createCandidateClient(config) {
  const baseUrl = `http://127.0.0.1:${config.candidate.port}`;

  async function request({
    method = 'GET',
    pathname,
    runId,
    body,
    headers = {},
    timeoutMs = 15000,
  }) {
    if (
      typeof pathname !== 'string' ||
      !pathname.startsWith('/') ||
      pathname.startsWith('//')
    ) {
      throw new Error('A valid relative API pathname is required');
    }

    if (typeof runId !== 'string' || !runId.trim()) {
      throw new Error('A valid benchmark runId is required');
    }

    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Benchmark-Run-Id': runId,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const responseText = await response.text();
    let responseBody = null;

    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    };
  }

  return { request };
}
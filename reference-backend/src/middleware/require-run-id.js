const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function requireRunId(request, response, next) {
  const runId = request.get('X-Benchmark-Run-Id');

  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    return response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'A valid X-Benchmark-Run-Id header is required',
      },
    });
  }

  request.runId = runId;
  return next();
}

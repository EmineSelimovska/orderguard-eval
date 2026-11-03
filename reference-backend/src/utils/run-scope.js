const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function withRunScope(request, filter = {}) {
  const runId = request?.runId;

  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError('A valid request.runId is required to scope the query');
  }

  if (
    filter === null
    || typeof filter !== 'object'
    || Array.isArray(filter)
  ) {
    throw new TypeError('Query filter must be an object');
  }

  return {
    ...filter,
    runId,
  };
}

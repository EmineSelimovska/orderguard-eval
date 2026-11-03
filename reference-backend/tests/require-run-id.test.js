import { jest } from '@jest/globals';
import { requireRunId } from '../src/middleware/require-run-id.js';

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe('requireRunId middleware', () => {
  test.each(['run_abc123', 'run-opaque-id'])(
    'accepts a valid run ID and makes it available downstream: %s',
    (runId) => {
      const request = {
        get: jest.fn().mockReturnValue(runId),
      };
      const response = createResponse();
      const next = jest.fn();

      requireRunId(request, response, next);

      expect(request.get).toHaveBeenCalledWith('X-Benchmark-Run-Id');
      expect(request.runId).toBe(runId);
      expect(next).toHaveBeenCalledTimes(1);
      expect(response.status).not.toHaveBeenCalled();
    },
  );

  test('rejects a missing run ID with the standard invalid-request response', () => {
    const request = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const response = createResponse();
    const next = jest.fn();

    requireRunId(request, response, next);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 'INVALID_REQUEST',
        message: 'A valid X-Benchmark-Run-Id header is required',
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(request.runId).toBeUndefined();
  });

  test.each(['', ' run-1', 'run 1', 'run/1', `${'a'.repeat(129)}`])(
    'rejects invalid run ID %s',
    (runId) => {
      const request = {
        get: jest.fn().mockReturnValue(runId),
      };
      const response = createResponse();
      const next = jest.fn();

      requireRunId(request, response, next);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith({
        error: {
          code: 'INVALID_REQUEST',
          message: 'A valid X-Benchmark-Run-Id header is required',
        },
      });
      expect(next).not.toHaveBeenCalled();
    },
  );
});

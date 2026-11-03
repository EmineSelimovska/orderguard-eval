import { withRunScope } from '../src/utils/run-scope.js';

describe('withRunScope', () => {
  test('combines a query filter with the request run ID', () => {
    const filter = withRunScope(
      { runId: 'run-1' },
      { sku: 'sku-1', available: { $gte: 1 } },
    );

    expect(filter).toEqual({
      sku: 'sku-1',
      available: { $gte: 1 },
      runId: 'run-1',
    });
  });

  test('request run ID overrides a conflicting filter run ID', () => {
    const filter = withRunScope(
      { runId: 'run-1' },
      { runId: 'run-2', sku: 'sku-1' },
    );

    expect(filter).toEqual({
      runId: 'run-1',
      sku: 'sku-1',
    });
  });

  test.each([undefined, null, '', 'run invalid', 'run/1', `${'a'.repeat(129)}`])(
    'rejects missing or invalid request run ID: %s',
    (runId) => {
      expect(() => withRunScope({ runId }, { sku: 'sku-1' })).toThrow(
        'A valid request.runId is required to scope the query',
      );
    },
  );
});

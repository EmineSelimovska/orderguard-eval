import { jest } from '@jest/globals';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadServerWithMocks({
  rejectedModelName,
  deferModelInitialization = false,
  duringStartup,
} = {}) {
  const connectDatabase = jest.fn().mockResolvedValue({});
  const disconnectDatabase = jest.fn().mockResolvedValue(undefined);
  const listen = jest.fn().mockReturnValue({});
  const createApp = jest.fn(() => ({ listen }));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  const originalExitCode = process.exitCode;
  const originalSigintListeners = new Set(process.listeners('SIGINT'));
  const originalSigtermListeners = new Set(process.listeners('SIGTERM'));
  const modelNames = ['Product', 'Order', 'Payment', 'ProcessedWebhook'];
  const initDeferreds = modelNames.map(() => createDeferred());
  const registeredModels = modelNames.map((modelName, index) => ({
    modelName,
    init: jest.fn().mockImplementation(() => {
      if (modelName === rejectedModelName) {
        return Promise.reject(new Error('mock index initialization failure'));
      }
      return deferModelInitialization
        ? initDeferreds[index].promise
        : Promise.resolve();
    }),
  }));
  const initializeModelIndexes = jest.fn(async () => {
    for (const model of registeredModels) {
      try {
        await model.init();
      } catch (error) {
        throw new Error(
          `Failed to initialize indexes for ${model.modelName}`,
          { cause: error },
        );
      }
    }
  });

  jest.unstable_mockModule('../src/config/database.js', () => ({
    connectDatabase,
    disconnectDatabase,
  }));
  jest.unstable_mockModule('../src/app.js', () => ({ createApp }));
  jest.unstable_mockModule('../src/models/index.js', () => ({
    initializeModelIndexes,
    registeredModels,
  }));
  jest.unstable_mockModule('dotenv', () => ({
    default: { config: jest.fn() },
  }));

  await jest.isolateModulesAsync(async () => {
    const startupPromise = import('../src/server.js');
    if (duringStartup) {
      await duringStartup({
        registeredModels,
        initDeferreds,
        listen,
        startupPromise,
      });
    }
    await startupPromise;
  });

  return {
    connectDatabase,
    disconnectDatabase,
    listen,
    createApp,
    registeredModels,
    initializeModelIndexes,
    consoleError,
    consoleLog,
    cleanup() {
      for (const listener of process.listeners('SIGINT')) {
        if (!originalSigintListeners.has(listener)) {
          process.removeListener('SIGINT', listener);
        }
      }
      for (const listener of process.listeners('SIGTERM')) {
        if (!originalSigtermListeners.has(listener)) {
          process.removeListener('SIGTERM', listener);
        }
      }
      process.exitCode = originalExitCode;
      consoleError.mockRestore();
      consoleLog.mockRestore();
    },
  };
}

describe('Reference Backend startup', () => {
  afterEach(() => {
    jest.unstable_unmockModule('../src/config/database.js');
    jest.unstable_unmockModule('../src/app.js');
    jest.unstable_unmockModule('../src/models/index.js');
    jest.unstable_unmockModule('dotenv');
    jest.resetModules();
  });

  test('does not listen until every model index initialization resolves', async () => {
    const context = await loadServerWithMocks({
      deferModelInitialization: true,
      duringStartup: async ({ registeredModels, initDeferreds, listen, startupPromise }) => {
        await new Promise(setImmediate);
        expect(registeredModels[0].init).toHaveBeenCalledTimes(1);
        expect(listen).not.toHaveBeenCalled();

        for (let index = 0; index < registeredModels.length; index += 1) {
          expect(listen).not.toHaveBeenCalled();
          initDeferreds[index].resolve();

          if (index + 1 < registeredModels.length) {
            await new Promise(setImmediate);
            expect(registeredModels[index + 1].init).toHaveBeenCalledTimes(1);
            expect(listen).not.toHaveBeenCalled();
          }
        }

        await startupPromise;
        expect(listen).toHaveBeenCalledTimes(1);
      },
    });

    try {
      expect(context.registeredModels.every((model) => (
        model.init.mock.results[0].type === 'return'
      ))).toBe(true);
      expect(context.initializeModelIndexes).toHaveBeenCalledTimes(1);
      expect(context.connectDatabase).toHaveBeenCalledTimes(1);
      expect(context.listen).toHaveBeenCalledTimes(1);
      expect(context.disconnectDatabase).not.toHaveBeenCalled();
    } finally {
      context.cleanup();
    }
  }, 15000);

  test('does not listen and disconnects when model index initialization rejects', async () => {
    const context = await loadServerWithMocks({
      rejectedModelName: 'Order',
    });

    try {
      expect(context.listen).not.toHaveBeenCalled();
      expect(context.disconnectDatabase).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      expect(context.consoleError).toHaveBeenCalledWith(
        'Reference backend startup failed: Failed to initialize indexes for Order; server not started',
      );
      expect(context.registeredModels[1].init).toHaveBeenCalledTimes(1);
      expect(context.registeredModels[2].init).not.toHaveBeenCalled();
    } finally {
      context.cleanup();
    }
  });
});

import { jest } from '@jest/globals';
import {
  initializeModelIndexes,
  registeredModels,
} from '../src/models/index.js';

describe('model index initialization', () => {
  test('registers all four persistence models', () => {
    expect(registeredModels.map((model) => model.modelName)).toEqual([
      'Product',
      'Order',
      'Payment',
      'ProcessedWebhook',
    ]);
  });

  test('waits for each registered model to finish initialization', async () => {
    const models = [
      { modelName: 'First', init: jest.fn().mockResolvedValue('first-ready') },
      { modelName: 'Second', init: jest.fn().mockResolvedValue('second-ready') },
    ];

    await expect(initializeModelIndexes(models)).resolves.toBeUndefined();

    expect(models[0].init).toHaveBeenCalledTimes(1);
    expect(models[1].init).toHaveBeenCalledTimes(1);
  });

  test('reports an index initialization failure with its model name', async () => {
    const models = [
      { modelName: 'Product', init: jest.fn().mockRejectedValue(new Error('index failed')) },
      { modelName: 'Order', init: jest.fn() },
    ];

    await expect(initializeModelIndexes(models)).rejects.toThrow(
      'Failed to initialize indexes for Product',
    );
    expect(models[1].init).not.toHaveBeenCalled();
  });
});

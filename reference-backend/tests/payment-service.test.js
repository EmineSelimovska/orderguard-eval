import { jest } from '@jest/globals';
import {
  PaymentAttemptAlreadyClaimedError,
  PaymentOrderNotFoundError,
  PaymentRecordMissingError,
  preparePaymentAttempt,
} from '../src/services/payments.js';

const runId = 'run-1';
const orderId = 'order-1';
const order = {
  _id: orderId,
  runId,
  paymentId: 'payment-1',
};
const payment = {
  _id: 'payment-1',
  runId,
  orderId,
  operationKey: 'op-stable-1',
  status: 'processing',
  attemptCount: 1,
};

function createModels({
  foundOrder = order,
  foundPayment = { ...payment, status: 'pending', attemptCount: 0 },
  claimedPayment = payment,
} = {}) {
  const OrderModel = {
    findOne: jest.fn().mockResolvedValue(foundOrder),
  };
  const PaymentModel = {
    findOne: jest.fn().mockResolvedValue(foundPayment),
    findOneAndUpdate: jest.fn().mockResolvedValue(claimedPayment),
  };

  return { OrderModel, PaymentModel };
}

describe('preparePaymentAttempt', () => {
  test('finds the order and linked payment within the requested run', async () => {
    const models = createModels();

    await preparePaymentAttempt({ runId, orderId }, models);

    expect(models.OrderModel.findOne).toHaveBeenCalledWith({
      runId,
      _id: orderId,
    });
    expect(models.PaymentModel.findOne).toHaveBeenCalledWith({
      runId,
      _id: order.paymentId,
      orderId: String(order._id),
    });
    expect(models.PaymentModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        runId,
        _id: payment._id,
        orderId: String(order._id),
        status: 'pending',
      },
      {
        $set: { status: 'processing' },
        $inc: { attemptCount: 1 },
      },
      { new: true, runValidators: true },
    );
  });

  test('returns the persisted operation key and claimed attempt state', async () => {
    const models = createModels();

    await expect(preparePaymentAttempt({ runId, orderId }, models))
      .resolves.toEqual({
        order,
        payment,
        operationKey: 'op-stable-1',
      });

    expect(models.PaymentModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('does not claim a Payment when the Order is missing from this run', async () => {
    const models = createModels({ foundOrder: null });

    await expect(preparePaymentAttempt({ runId, orderId }, models))
      .rejects.toBeInstanceOf(PaymentOrderNotFoundError);

    expect(models.OrderModel.findOne).toHaveBeenCalledWith({ runId, _id: orderId });
    expect(models.PaymentModel.findOne).not.toHaveBeenCalled();
    expect(models.PaymentModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not claim a Payment that is missing or not linked in this run', async () => {
    const models = createModels({ foundPayment: null });

    await expect(preparePaymentAttempt({ runId, orderId }, models))
      .rejects.toBeInstanceOf(PaymentRecordMissingError);

    expect(models.PaymentModel.findOne).toHaveBeenCalledWith({
      runId,
      _id: order.paymentId,
      orderId,
    });
    expect(models.PaymentModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('reuses the persisted operation key and never generates a replacement', async () => {
    const existingOperationKey = 'op-created-with-order';
    const models = createModels({
      foundPayment: { ...payment, operationKey: existingOperationKey, status: 'pending' },
      claimedPayment: { ...payment, operationKey: existingOperationKey },
    });

    const result = await preparePaymentAttempt({ runId, orderId }, models);

    expect(result.operationKey).toBe(existingOperationKey);
    expect(models.PaymentModel.findOneAndUpdate.mock.calls[0][1])
      .not.toHaveProperty('$set.operationKey');
  });

  test('reports a competing initial claim when the conditional update matches no record', async () => {
    const models = createModels({ claimedPayment: null });

    await expect(preparePaymentAttempt({ runId, orderId }, models))
      .rejects.toBeInstanceOf(PaymentAttemptAlreadyClaimedError);

    expect(models.PaymentModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(models.PaymentModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      runId,
      _id: payment._id,
      orderId,
      status: 'pending',
    });
  });

  test('allows only one of two competing initial claims to increment the attempt count', async () => {
    let currentPayment = { ...payment, status: 'pending', attemptCount: 0 };
    const OrderModel = {
      findOne: jest.fn().mockResolvedValue(order),
    };
    const PaymentModel = {
      findOne: jest.fn().mockImplementation(async () => ({ ...currentPayment })),
      findOneAndUpdate: jest.fn().mockImplementation(async (filter, update) => {
        if (
          currentPayment.runId !== filter.runId
          || currentPayment._id !== filter._id
          || currentPayment.orderId !== filter.orderId
          || currentPayment.status !== filter.status
        ) {
          return null;
        }

        currentPayment = {
          ...currentPayment,
          ...update.$set,
          attemptCount: currentPayment.attemptCount + update.$inc.attemptCount,
        };
        return { ...currentPayment };
      }),
    };
    const dependencies = { OrderModel, PaymentModel };

    const results = await Promise.allSettled([
      preparePaymentAttempt({ runId, orderId }, dependencies),
      preparePaymentAttempt({ runId, orderId }, dependencies),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason)
      .toBeInstanceOf(PaymentAttemptAlreadyClaimedError);
    expect(currentPayment).toMatchObject({
      status: 'processing',
      attemptCount: 1,
    });
    expect(PaymentModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test('rejects invalid identifiers before querying models', async () => {
    const models = createModels();

    await expect(preparePaymentAttempt({ runId: 'invalid run', orderId }, models))
      .rejects.toThrow('A valid runId is required');
    await expect(preparePaymentAttempt({ runId, orderId: '' }, models))
      .rejects.toThrow('A non-empty orderId is required');

    expect(models.OrderModel.findOne).not.toHaveBeenCalled();
    expect(models.PaymentModel.findOne).not.toHaveBeenCalled();
    expect(models.PaymentModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

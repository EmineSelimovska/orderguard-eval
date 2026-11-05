import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { assertSafeAtlasIntegrationEnvironment } from './atlas-integration-safety.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { initializeModelIndexes } from '../src/models/index.js';
import Order from '../src/models/order.js';
import Payment from '../src/models/payment.js';
import Product from '../src/models/product.js';
import { mockPaymentProvider } from '../src/provider/mock-payment-provider.js';
import { createOrder } from '../src/services/orders.js';
import { attemptPayment } from '../src/services/payments.js';

const atlasDescribe = process.env.ORDERGUARD_ATLAS_INTEGRATION === '1'
  ? describe
  : describe.skip;

atlasDescribe('Payment Service Atlas integration', () => {
  jest.setTimeout(30000);

  let runId;
  let connected = false;

  beforeAll(async () => {
    assertSafeAtlasIntegrationEnvironment();
    await connectDatabase();
    connected = true;
    await initializeModelIndexes();
  }, 60000);

  afterAll(async () => {
    if (connected) {
      await disconnectDatabase();
    }
  });

  beforeEach(() => {
    runId = `atlas_pay_${randomUUID().replaceAll('-', '')}`;
    mockPaymentProvider.clearRun(runId);
  });

  afterEach(async () => {
    if (!runId) {
      return;
    }

    try {
      await Promise.all([
        Payment.deleteMany({ runId }),
        Order.deleteMany({ runId }),
        Product.deleteMany({ runId }),
      ]);
    } finally {
      mockPaymentProvider.clearRun(runId);
      runId = undefined;
    }
  });

  async function createReservedOrder() {
    const sku = `sku-${runId}`;
    await Product.create({
      runId,
      sku,
      name: 'Atlas payment integration fixture',
      available: 5,
      unitPriceMinor: 1250,
      currency: 'USD',
    });

    const created = await createOrder({
      runId,
      idempotencyKey: `key-${runId}`,
      orderRequest: { sku, quantity: 2 },
    });

    return created;
  }

  function realSessionTracker() {
    const sessions = [];
    return {
      sessions,
      startSession: async () => {
        const session = await mongoose.startSession();
        sessions.push(session);
        return session;
      },
    };
  }

  function expectTransactionStates(tracker, expectedStates) {
    expect(tracker.sessions.map(({ transaction }) => transaction.state))
      .toEqual(expectedStates);
  }

  test('commits success, consumes the hold, and does not decrement available stock again', async () => {
    const { order, payment } = await createReservedOrder();
    const tracker = realSessionTracker();
    mockPaymentProvider.configureChargeOutcome(
      runId,
      payment.operationKey,
      'success',
    );

    await attemptPayment(
      { runId, orderId: String(order._id) },
      { startSession: tracker.startSession },
    );

    const storedPayment = await Payment.findOne({
      runId,
      _id: payment._id,
      orderId: String(order._id),
    }).lean();
    const storedOrder = await Order.findOne({ runId, _id: order._id }).lean();
    const product = await Product.findOne({ runId, sku: order.items[0].sku }).lean();

    expect(storedPayment).toMatchObject({
      status: 'succeeded',
      lastSafeOutcome: 'succeeded',
    });
    expect(storedPayment.providerOperationReference).toBeTruthy();
    expect(storedOrder).toMatchObject({
      status: 'paid',
      inventoryDisposition: 'consumed',
    });
    expect(product.available).toBe(3);
    expect(mockPaymentProvider.inspectLedger(runId).captures).toHaveLength(1);
    expectTransactionStates(tracker, [
      'TRANSACTION_COMMITTED',
      'TRANSACTION_COMMITTED',
    ]);
  });

  test('commits decline and restores the reserved inventory once', async () => {
    const { order, payment } = await createReservedOrder();
    const tracker = realSessionTracker();
    mockPaymentProvider.configureChargeOutcome(
      runId,
      payment.operationKey,
      'decline',
    );

    await attemptPayment(
      { runId, orderId: String(order._id) },
      { startSession: tracker.startSession },
    );

    const storedPayment = await Payment.findOne({
      runId,
      _id: payment._id,
      orderId: String(order._id),
    }).lean();
    const storedOrder = await Order.findOne({ runId, _id: order._id }).lean();
    const product = await Product.findOne({ runId, sku: order.items[0].sku }).lean();

    expect(storedPayment).toMatchObject({
      status: 'declined',
      lastSafeOutcome: 'declined',
    });
    expect(storedOrder).toMatchObject({
      status: 'payment_failed',
      inventoryDisposition: 'released',
    });
    expect(product.available).toBe(5);
    expect(mockPaymentProvider.inspectLedger(runId).captures).toHaveLength(0);
    expectTransactionStates(tracker, [
      'TRANSACTION_COMMITTED',
      'TRANSACTION_COMMITTED',
    ]);
  });

  test('allows only one concurrent claimant to call the provider', async () => {
    const { order, payment } = await createReservedOrder();
    const tracker = realSessionTracker();
    mockPaymentProvider.configureChargeOutcome(
      runId,
      payment.operationKey,
      'success',
    );

    const results = await Promise.allSettled([
      attemptPayment(
        { runId, orderId: String(order._id) },
        { startSession: tracker.startSession },
      ),
      attemptPayment(
        { runId, orderId: String(order._id) },
        { startSession: tracker.startSession },
      ),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const storedPayment = await Payment.findOne({
      runId,
      _id: payment._id,
      orderId: String(order._id),
    }).lean();
    const storedOrder = await Order.findOne({ runId, _id: order._id }).lean();

    expect(storedPayment).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(storedOrder).toMatchObject({ status: 'paid', version: 2 });
    expect(mockPaymentProvider.inspectLedger(runId).captures).toHaveLength(1);
    expect(tracker.sessions.length).toBeGreaterThanOrEqual(2);
    expect(tracker.sessions.some(({ transaction }) => (
      transaction.state === 'TRANSACTION_COMMITTED'
    ))).toBe(true);
  });

  test('aborts the real outcome transaction after a persistence failure following provider success', async () => {
    const { order, payment } = await createReservedOrder();
    const tracker = realSessionTracker();
    const writes = [];
    const persistenceError = new Error('Injected failure after Product update');
    let beforeTransaction;
    const originalPaymentUpdate = Payment.findOneAndUpdate;
    const originalOrderUpdate = Order.findOneAndUpdate;
    const originalProductUpdate = Product.findOneAndUpdate;
    let sessionStartCount = 0;

    mockPaymentProvider.configureChargeOutcome(
      runId,
      payment.operationKey,
      'success',
    );

    const readPersistedState = async () => ({
      payment: await Payment.findOne({
        runId,
        _id: payment._id,
        orderId: String(order._id),
      }).lean(),
      order: await Order.findOne({ runId, _id: order._id }).lean(),
      product: await Product.findOne({
        runId,
        sku: order.items[0].sku,
      }).lean(),
    });

    Payment.findOneAndUpdate = async function (...args) {
      const result = await originalPaymentUpdate.apply(this, args);
      if (args[2]?.session && !args[1]?.$inc?.attemptCount) {
        writes.push({ model: 'Payment', result, session: args[2].session });
      }
      return result;
    };
    Order.findOneAndUpdate = async function (...args) {
      const result = await originalOrderUpdate.apply(this, args);
      if (args[2]?.session && args[1]?.$set?.status) {
        writes.push({ model: 'Order', result, session: args[2].session });
      }
      if (result && args[1]?.$set?.status) {
        // The success path has no Product write; exercise one here to verify rollback.
        await Product.findOneAndUpdate(
          { runId, _id: order.items[0].productId },
          { $inc: { available: 2 } },
          {
            new: true,
            runValidators: true,
            session: args[2]?.session,
          },
        );
      }
      return result;
    };
    Product.findOneAndUpdate = async function (...args) {
      const result = await originalProductUpdate.apply(this, args);
      if (!result) {
        throw new Error('Expected the real Product update to succeed before injection');
      }
      writes.push({ model: 'Product', result, session: args[2]?.session });
      throw persistenceError;
    };

    try {
      await expect(attemptPayment(
        { runId, orderId: String(order._id) },
        {
          startSession: async () => {
            sessionStartCount += 1;
            if (sessionStartCount === 2) {
              beforeTransaction = await readPersistedState();
            }
            return tracker.startSession();
          },
        },
      )).rejects.toBe(persistenceError);

      const afterAbort = await readPersistedState();
      const ledger = mockPaymentProvider.inspectLedger(runId);

      expect(beforeTransaction).toMatchObject({
        payment: {
          status: 'processing',
          lastSafeOutcome: 'pending',
          providerOperationReference: null,
        },
        order: {
          status: 'pending_payment',
          inventoryDisposition: 'held',
        },
        product: { available: 3 },
      });
      expect(writes.map(({ model }) => model)).toEqual([
        'Payment',
        'Order',
        'Product',
      ]);
      expect(writes.every(({ result, session }) => (
        Boolean(result) && session === tracker.sessions[1]
      ))).toBe(true);
      expect(writes[0].result.status).toBe('succeeded');
      expect(writes[1].result).toMatchObject({
        status: 'paid',
        inventoryDisposition: 'consumed',
      });
      expect(writes[2].result.available).toBe(5);

      expect(afterAbort.payment).toEqual(beforeTransaction.payment);
      expect(afterAbort.order).toEqual(beforeTransaction.order);
      expect(afterAbort.product).toEqual(beforeTransaction.product);
      expect(afterAbort.payment.status).not.toBe('declined');
      expect(afterAbort.order.status).not.toBe('payment_failed');
      expect(ledger.operations).toMatchObject([{
        operationKey: payment.operationKey,
        status: 'succeeded',
      }]);
      expect(ledger.captures).toHaveLength(1);
      expectTransactionStates(tracker, [
        'TRANSACTION_COMMITTED',
        'TRANSACTION_ABORTED',
      ]);
    } finally {
      Payment.findOneAndUpdate = originalPaymentUpdate;
      Order.findOneAndUpdate = originalOrderUpdate;
      Product.findOneAndUpdate = originalProductUpdate;
    }
  });
});

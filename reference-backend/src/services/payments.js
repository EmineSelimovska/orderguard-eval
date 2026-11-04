import Order from '../models/order.js';
import Payment from '../models/payment.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class PaymentOrderNotFoundError extends Error {
  constructor() {
    super('Order was not found');
    this.name = 'PaymentOrderNotFoundError';
    this.code = 'NOT_FOUND';
    this.status = 404;
  }
}

export class PaymentRecordMissingError extends Error {
  constructor() {
    super('Payment record for the order was not found');
    this.name = 'PaymentRecordMissingError';
    this.code = 'SERVICE_UNAVAILABLE';
    this.status = 503;
  }
}

export class PaymentAttemptAlreadyClaimedError extends Error {
  constructor() {
    super('The initial payment attempt is no longer available');
    this.name = 'PaymentAttemptAlreadyClaimedError';
    this.code = 'PAYMENT_ATTEMPT_IN_PROGRESS';
    this.status = 409;
  }
}

export async function preparePaymentAttempt({
  runId,
  orderId,
} = {}, {
  OrderModel = Order,
  PaymentModel = Payment,
} = {}) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError('A valid runId is required');
  }
  if (typeof orderId !== 'string' || orderId.trim().length === 0) {
    throw new TypeError('A non-empty orderId is required');
  }

  const order = await OrderModel.findOne({ runId, _id: orderId });
  if (!order) {
    throw new PaymentOrderNotFoundError();
  }

  const storedOrderId = String(order._id);
  const payment = await PaymentModel.findOne({
    runId,
    _id: order.paymentId,
    orderId: storedOrderId,
  });
  if (!payment) {
    throw new PaymentRecordMissingError();
  }

  const claimedPayment = await PaymentModel.findOneAndUpdate(
    {
      runId,
      _id: payment._id,
      orderId: storedOrderId,
      status: 'pending',
    },
    {
      $set: { status: 'processing' },
      $inc: { attemptCount: 1 },
    },
    { new: true, runValidators: true },
  );
  if (!claimedPayment) {
    throw new PaymentAttemptAlreadyClaimedError();
  }

  return {
    order,
    payment: claimedPayment,
    operationKey: claimedPayment.operationKey,
  };
}

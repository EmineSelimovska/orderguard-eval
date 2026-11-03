import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      trim: true,
    },
    orderId: {
      type: String,
      required: true,
    },
    operationKey: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      required: true,
      enum: [
        'pending',
        'processing',
        'unknown',
        'succeeded',
        'declined',
        'voided',
        'refund_pending',
        'refunded',
      ],
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 0,
      max: 100000000,
      validate: {
        validator: Number.isInteger,
        message: 'amountMinor must be an integer',
      },
    },
    currency: {
      type: String,
      required: true,
      enum: ['USD', 'EUR', 'GBP'],
    },
    attemptCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'attemptCount must be an integer',
      },
    },
    lastSafeOutcome: {
      type: String,
      required: true,
      default: 'pending',
    },
    providerOperationReference: {
      type: String,
      default: null,
    },
    refundOperationKey: {
      type: String,
    },
    refundOperationReference: {
      type: String,
    },
    capturedAt: {
      type: Date,
    },
    refundedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

paymentSchema.index({ runId: 1, orderId: 1 }, { unique: true });
paymentSchema.index({ runId: 1, operationKey: 1 }, { unique: true });
paymentSchema.index(
  { providerOperationReference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerOperationReference: { $type: 'string' },
    },
  },
);

export default mongoose.model('Payment', paymentSchema);

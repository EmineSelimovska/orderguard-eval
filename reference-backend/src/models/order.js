import mongoose from 'mongoose';

const itemSchema = new mongoose.Schema(
  {
    productId: {
      type: String,
      required: true,
    },
    sku: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      validate: {
        validator: Number.isInteger,
        message: 'quantity must be an integer',
      },
    },
    unitPriceMinor: {
      type: Number,
      required: true,
      min: 0,
      max: 100000000,
      validate: {
        validator: Number.isInteger,
        message: 'unitPriceMinor must be an integer',
      },
    },
    lineAmountMinor: {
      type: Number,
      required: true,
      min: 0,
      max: 100000000,
      validate: {
        validator: Number.isInteger,
        message: 'lineAmountMinor must be an integer',
      },
    },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      trim: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },
    requestHash: {
      type: String,
      required: true,
    },
    items: {
      type: [itemSchema],
      required: true,
      validate: {
        validator: (items) => items.length === 1,
        message: 'an order must contain exactly one item',
      },
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
    status: {
      type: String,
      required: true,
      enum: [
        'pending_payment',
        'paid',
        'payment_failed',
        'cancellation_pending_refund',
        'cancelled',
      ],
    },
    paymentId: {
      type: String,
      required: true,
    },
    inventoryDisposition: {
      type: String,
      required: true,
      enum: ['held', 'consumed', 'released'],
    },
    version: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'version must be an integer',
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

orderSchema.index({ runId: 1, idempotencyKey: 1 }, { unique: true });
orderSchema.index({ runId: 1, _id: 1 });
orderSchema.index({ runId: 1, createdAt: 1 });

export default mongoose.model('Order', orderSchema);

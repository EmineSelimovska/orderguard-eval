import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      trim: true,
    },
    sku: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    available: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'available must be an integer',
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
    currency: {
      type: String,
      required: true,
      enum: ['USD', 'EUR', 'GBP'],
    },
  },
  {
    timestamps: true,
  },
);

productSchema.index({ runId: 1, sku: 1 }, { unique: true });
productSchema.index({ runId: 1, updatedAt: 1 });

export default mongoose.model('Product', productSchema);

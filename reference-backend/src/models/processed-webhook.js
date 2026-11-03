import mongoose from 'mongoose';

const processedWebhookSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      trim: true,
    },
    eventId: {
      type: String,
      required: true,
      trim: true,
    },
    payloadHash: {
      type: String,
      required: true,
    },
    paymentId: {
      type: String,
      required: true,
    },
    operationKey: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['payment.succeeded', 'payment.declined'],
    },
    processingResult: {
      type: String,
      required: true,
    },
    processedAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

processedWebhookSchema.index({ runId: 1, eventId: 1 }, { unique: true });
processedWebhookSchema.index({ runId: 1, paymentId: 1, processedAt: 1 });

export default mongoose.model('ProcessedWebhook', processedWebhookSchema);


import mongoose from 'mongoose';

export async function connectDatabase(uri = process.env.MONGODB_URI) {
  if (!uri) {
    throw new Error('MONGODB_URI is required to connect to MongoDB Atlas');
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    });

    console.log('MongoDB connected successfully:', {
      host: mongoose.connection.host,
      database: mongoose.connection.name,
    });

    return mongoose.connection;
  } catch (error) {
    console.error('MongoDB connection failed:', {
      name: error.name,
      code: error.code,
      message: error.message,
    });

    throw error;
  }
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

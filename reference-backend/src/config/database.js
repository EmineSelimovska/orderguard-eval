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
      database: mongoose.connection.name,
    });

    return mongoose.connection;
  } catch {
    console.error('MongoDB connection failed; connection details suppressed');
    throw new Error('MongoDB Atlas connection failed');
  }
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

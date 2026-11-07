
import { MongoClient } from 'mongodb';

const MAX_DOCUMENTS_PER_COLLECTION = 10000;

export async function createMongoObserver(config) {
  if (!config?.observer?.mongoUri) {
    throw new Error('Observer MongoDB URI is required');
  }

  const client = new MongoClient(config.observer.mongoUri, {
    readPreference: 'primary',
    serverSelectionTimeoutMS: 10000,
    appName: 'OrderGuard-Eval-Observer',
  });

  await client.connect();

  const database = client.db();

  return {
    async getRunDocuments(runId) {
      if (typeof runId !== 'string' || !runId.trim()) {
        throw new Error('A valid runId is required');
      }

      const collections = await database
        .listCollections({}, { nameOnly: true })
        .toArray();

      const result = {};

      for (const collection of collections) {
        const documents = await database
          .collection(collection.name)
          .find(
            { runId },
            {
              maxTimeMS: 10000,
            },
          )
          .limit(MAX_DOCUMENTS_PER_COLLECTION + 1)
          .toArray();

        if (documents.length > MAX_DOCUMENTS_PER_COLLECTION) {
          throw new Error(
            `Observer document limit exceeded in collection: ${collection.name}`,
          );
        }

        if (documents.length > 0) {
          result[collection.name] = documents;
        }
      }

      return result;
    },

    async close() {
      await client.close();
    },
  };
}

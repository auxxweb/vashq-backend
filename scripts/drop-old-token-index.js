/**
 * Script to drop the old single-field tokenNumber index
 * Run this once to clean up the old index after updating the model
 * 
 * Usage: node scripts/drop-old-token-index.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/washq_saas';

async function dropOldIndex() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('jobs');

    // List all indexes
    console.log('\nCurrent indexes:');
    const indexes = await collection.indexes();
    indexes.forEach(index => {
      console.log(`  - ${index.name}:`, JSON.stringify(index.key));
    });

    // Try to drop the old tokenNumber_1 index
    try {
      console.log('\nAttempting to drop old tokenNumber_1 index...');
      await collection.dropIndex('tokenNumber_1');
      console.log('✅ Successfully dropped tokenNumber_1 index');
    } catch (error) {
      if (error.code === 27 || error.message.includes('index not found')) {
        console.log('ℹ️  tokenNumber_1 index does not exist (already dropped or never created)');
      } else {
        throw error;
      }
    }

    // Verify the compound index exists
    console.log('\nVerifying compound index (businessId_1_tokenNumber_1)...');
    const updatedIndexes = await collection.indexes();
    const compoundIndex = updatedIndexes.find(
      idx => idx.name === 'businessId_1_tokenNumber_1' || 
             (idx.key && idx.key.businessId === 1 && idx.key.tokenNumber === 1)
    );

    if (compoundIndex) {
      console.log('✅ Compound unique index (businessId + tokenNumber) exists');
    } else {
      console.log('⚠️  Warning: Compound unique index not found. It will be created automatically on next server start.');
    }

    console.log('\n✅ Index cleanup complete!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\nMongoDB connection closed');
  }
}

dropOldIndex();

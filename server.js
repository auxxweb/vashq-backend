// Load env first so CLOUDINARY_* etc. are available when routes load
import 'dotenv/config';

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// ES6 module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import routes
import authRoutes from './routes/auth.routes.js';
import superAdminRoutes from './routes/superAdmin.routes.js';
import adminRoutes from './routes/admin.routes.js';
import publicRoutes from './routes/public.routes.js';
import packageRoutes from './routes/packages.routes.js';
import businessRoutes from './routes/business.routes.js';
import { initFirebaseAdmin } from './services/firebaseAdmin.js';
import { startCronJobs } from './cronJobs.js';

const app = express();

// Middleware - allow FRONTEND_URL (string or comma-separated) or defaults
const corsOrigin = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((s) => s.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:4173', 'https://vashq.com'];
app.use(cors({
  origin: corsOrigin.length === 1 ? corsOrigin[0] : corsOrigin,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Note: Image uploads use multipart (multer), max 20MB per file × 4. Client compresses before upload. If you see "Upload failed" on mobile, set proxy body limit: nginx client_max_body_size 10M; or API Gateway payload limit ≥ 10MB.

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/public', publicRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/washq_saas');
    console.log('MongoDB connected successfully');

    // Migration guard: older deployments may have a non-sparse unique index on invoices.jobId (jobId_1),
    // which breaks package invoices (jobId is null). Drop it once on startup if present.
    try {
      const coll = mongoose.connection.collection('invoices');
      const indexes = await coll.indexes();
      const hasLegacyJobIdUnique = indexes.some((i) => i.name === 'jobId_1' && i.unique);
      if (hasLegacyJobIdUnique) {
        await coll.dropIndex('jobId_1');
        console.log('Dropped legacy invoices index jobId_1');
      }
    } catch (e) {
      console.warn('Invoice index migration skipped:', e?.message || e);
    }

    // Initialize Firebase + cron jobs after DB is ready
    try {
      initFirebaseAdmin();
      console.log('Firebase admin initialized');
    } catch (e) {
      console.warn('Firebase init skipped:', e?.message || e);
    }
    try {
      startCronJobs();
      console.log('Cron jobs scheduled');
    } catch (e) {
      console.warn('Cron jobs not started:', e?.message || e);
    }
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

connectDB();

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;

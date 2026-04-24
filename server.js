// Load env first so CLOUDINARY_* etc. are available when routes load
import 'dotenv/config';

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// ES6 module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const backendPkg = require('./package.json');

// Import routes
import authRoutes from './routes/auth.routes.js';
import superAdminRoutes from './routes/superAdmin.routes.js';
import adminRoutes from './routes/admin.routes.js';
import publicRoutes from './routes/public.routes.js';

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

// Version check (frontend safety for backend compatibility)
app.get('/version.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json({
    version: process.env.APP_VERSION || backendPkg.version || '0.0.0',
    name: backendPkg.name || 'backend',
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/admin', adminRoutes);
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

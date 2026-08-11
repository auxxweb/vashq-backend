// Load env first so CLOUDINARY_* etc. are available when routes load
import 'dotenv/config';

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
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
import aiInsightsRoutes from './routes/aiInsights.routes.js';
import bookingAdminRoutes from './routes/bookingAdmin.routes.js';
import crmRoutes from './routes/crm.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import vehicleScannerRoutes from './routes/vehicleScanner.routes.js';
import { initFirebaseAdmin } from './services/firebaseAdmin.js';
import branchesRoutes from './routes/branches.routes.js';
import { startCronJobs } from './cronJobs.js';
import { resolveCorsAllowlist } from './utils/frontendUrl.js';

const app = express();

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  const secret = process.env.JWT_SECRET || '';
  if (!secret || secret === 'your-secret-key-change-in-production') {
    console.error('FATAL: Set a strong JWT_SECRET in production.');
    process.exit(1);
  }
}

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS — merge FRONTEND_URL / PUBLIC_FRONTEND_URL with production defaults (vashq.com, www, beta)
const corsAllowlist = resolveCorsAllowlist();
app.use(cors({
  origin(origin, callback) {
    // Non-browser / same-origin tools (curl, health checks) send no Origin
    if (!origin) return callback(null, true);
    const normalized = String(origin).trim().replace(/\/$/, '');
    if (corsAllowlist.includes(normalized)) {
      return callback(null, true);
    }
    console.warn('CORS blocked origin:', normalized, '| allowlist size:', corsAllowlist.length);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Branch-Id', 'X-Branch-Scope', 'X-Requested-With'],
  optionsSuccessStatus: 204
}));
// Explicit preflight for all API paths (helps some proxies)
app.options('*', cors());

app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// Note: Image uploads use multipart (multer), max 20MB per file × 4. Client compresses before upload. If you see "Upload failed" on mobile, set proxy body limit: nginx client_max_body_size 10M; or API Gateway payload limit ≥ 10MB.

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 3000);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') || req.path === '/api/health') return next();
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (elapsedMs >= SLOW_REQUEST_MS) {
      console.warn('Slow request:', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        elapsedMs: Math.round(elapsedMs),
        userId: req.user?._id ? String(req.user._id) : undefined,
        businessId: req.businessId ? String(req.businessId) : undefined
      });
    }
  });
  next();
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check (includes DB readiness for load balancers)
app.get('/api/health', (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? 'OK' : 'DEGRADED',
    db: dbReady ? 'connected' : 'disconnected',
    message: dbReady ? 'Server is running' : 'Database unavailable'
  });
});

// General API rate limit (auth routes have stricter limits below)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health' || req.method === 'OPTIONS',
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api', apiLimiter);

// Rate limit auth endpoints to reduce brute-force load
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/employee-login', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/register', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many registration attempts.' }
}));

// Routes — mount CRM/bookings before the catch-all /api/admin router so sales
// employees are not blocked by admin.routes allowAdminOrEmployeeForJobs.
app.use('/api/auth', authRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/admin/branches', branchesRoutes);
app.use('/api/admin/ai-insights', aiInsightsRoutes);
app.use('/api/admin/bookings', bookingAdminRoutes);
app.use('/api/admin/crm', crmRoutes);
app.use('/api/admin/attendance', attendanceRoutes);
app.use('/api/admin/vehicle-scanner', vehicleScannerRoutes);
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
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/washq_saas', {
      maxPoolSize: 20,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      maxIdleTimeMS: 30_000
    });
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

const startServer = async () => {
  await connectDB();
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;

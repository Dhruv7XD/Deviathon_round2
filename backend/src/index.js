'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { errorHandler } = require('./middleware/errorHandler');

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();

// Trust proxy (needed for rate-limiter X-Forwarded-For behind load balancers)
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────

const allowedOrigins = [
  'https://clearview-room.lovable.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4000',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS policy does not allow origin: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID', 'X-Client-Version'],
  exposedHeaders: ['Content-Length', 'X-Warning-Count', 'X-Session-Status'],
  credentials: true,
}));

// ─── Security & Body Parsing ──────────────────────────────────────────────────

app.use(helmet());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Request Logger (dev only) ────────────────────────────────────────────────

if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/health', require('./routes/health'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/assessments', require('./routes/assessments'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/proctoring', require('./routes/proctoring'));

// ─── 404 Handler ──────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'NotFound',
    message: `Route ${req.method} ${req.path} not found.`,
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   ProctorShield API                          ║
║   Listening on http://localhost:${PORT}          ║
║   Environment: ${(process.env.NODE_ENV || 'development').padEnd(29)}║
╚══════════════════════════════════════════════╝`);
});

module.exports = app;

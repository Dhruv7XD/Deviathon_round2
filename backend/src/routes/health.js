'use strict';

const express = require('express');
const db = require('../database');

const router = express.Router();

router.get('/', (req, res) => {
  let dbStatus = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbStatus = 'error';
  }

  const status = dbStatus === 'ok' ? 'healthy' : 'degraded';

  return res.status(dbStatus === 'ok' ? 200 : 503).json({
    success: true,
    message: 'ProctorShield API is running.',
    data: {
      status,
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      uptime_seconds: Math.floor(process.uptime()),
    },
  });
});

module.exports = router;

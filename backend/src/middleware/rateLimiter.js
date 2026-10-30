'use strict';

const rateLimit = require('express-rate-limit');

/**
 * OTP send limiter: 3 requests per 60 seconds per IP
 */
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'TooManyRequests',
    message: 'Too many OTP requests. Please wait 60 seconds before trying again.',
  },
});

/**
 * Auth limiter: 10 requests per 15 minutes per IP
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'TooManyRequests',
    message: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
});

/**
 * Telemetry limiter: 200 requests per minute per IP (high volume for proctoring logs)
 */
const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'TooManyRequests',
    message: 'Telemetry rate limit exceeded. Please slow down log submissions.',
  },
});

module.exports = { otpLimiter, authLimiter, telemetryLimiter };

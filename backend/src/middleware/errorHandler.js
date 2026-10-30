'use strict';

/**
 * Global error handler middleware.
 * Must be registered last in Express middleware chain.
 */
function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err.stack || err.message);

  const statusCode = err.statusCode || err.status || 500;
  const errorCode = err.code || 'InternalServerError';
  const message = (process.env.NODE_ENV === 'production' && statusCode === 500)
    ? 'An unexpected error occurred.'
    : err.message || 'An unexpected error occurred.';

  return res.status(statusCode).json({
    success: false,
    error: errorCode,
    message,
  });
}

module.exports = { errorHandler };

'use strict';

/**
 * Middleware factory: require one of the given roles.
 * Must be used after authenticate middleware.
 * Usage: requireRole('admin', 'examiner')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required.',
      });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: `Access denied. Required role(s): ${roles.join(', ')}.`,
      });
    }
    next();
  };
}

module.exports = { requireRole };

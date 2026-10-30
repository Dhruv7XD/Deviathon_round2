'use strict';

const jwt = require('jsonwebtoken');
const { supabase, isSupabaseConfigured } = require('../supabase');
const db = require('../database');

/**
 * Dual-Mode Authentication Middleware:
 * Supports BOTH native ProctorShield JWTs AND Supabase Auth access tokens.
 * Attaches req.user = { id, email, role, name } on success.
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header.',
    });
  }

  const token = authHeader.slice(7);

  // 1. Try native ProctorShield JWT verification
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role, name: decoded.name };
    return next();
  } catch (nativeErr) {
    // If not a native JWT, fall through to Supabase token verification
  }

  // 2. Try Supabase Auth verification if configured
  if (isSupabaseConfigured()) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) {
        const email = user.email || '';
        const role = user.user_metadata?.role || user.app_metadata?.role || 'candidate';
        const name = user.user_metadata?.name || user.user_metadata?.full_name || email.split('@')[0];

        // Ensure user exists in local SQLite DB cache
        const localUser = db.prepare('SELECT id, role, name FROM users WHERE id = ? OR email = ?').get(user.id, email);
        if (!localUser) {
          const now = new Date().toISOString();
          db.prepare(`
            INSERT INTO users (id, name, email, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(user.id, name, email, role, now, now);
        }

        req.user = {
          id: user.id,
          email,
          role: localUser ? localUser.role : role,
          name: localUser ? localUser.name : name,
          supabase_user: user,
        };
        return next();
      }
    } catch (supabaseErr) {
      // Supabase verification failed
    }
  }

  return res.status(401).json({
    success: false,
    error: 'TokenInvalid',
    message: 'Invalid or expired authentication token.',
  });
}

module.exports = { authenticate };

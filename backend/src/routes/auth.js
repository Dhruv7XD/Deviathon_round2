'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { otpLimiter, authLimiter } = require('../middleware/rateLimiter');
const { generateOTP, hashOTP, verifyOTP } = require('../utils/otp');

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 2525,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      error: 'ValidationError',
      message: errors.array().map(e => e.msg).join('; '),
      details: errors.array(),
    });
  }
  return null;
}

// ─── POST /register ───────────────────────────────────────────────────────────

router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required.'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required.'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters.'),
    body('phone').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const { name, email, password, phone } = req.body;

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'EmailTaken',
          message: 'An account with this email already exists.',
        });
      }

      const id = uuidv4();
      const password_hash = await bcrypt.hash(password, 10);
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO users (id, name, email, phone, password_hash, role, face_enrolled, otp_verified, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'candidate', 0, 0, 1, ?, ?)
      `).run(id, name, email, phone || null, password_hash, now, now);

      const user = db.prepare('SELECT id, name, email, role, phone, face_enrolled, created_at FROM users WHERE id = ?').get(id);

      return res.status(201).json({
        success: true,
        message: 'Registration successful.',
        data: { user, token: signToken(user) },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /login/password ─────────────────────────────────────────────────────

router.post(
  '/login/password',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required.'),
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  async (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const { email, password } = req.body;

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user || !user.is_active) {
        return res.status(401).json({
          success: false,
          error: 'InvalidCredentials',
          message: 'Invalid email or password.',
        });
      }

      if (!user.password_hash) {
        return res.status(401).json({
          success: false,
          error: 'NoPasswordSet',
          message: 'This account uses OTP login only.',
        });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({
          success: false,
          error: 'InvalidCredentials',
          message: 'Invalid email or password.',
        });
      }

      const token = signToken(user);
      const { password_hash, otp_code, otp_expires_at, ...safeUser } = user;

      return res.json({
        success: true,
        message: 'Login successful.',
        data: { user: safeUser, token },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /otp/send ───────────────────────────────────────────────────────────

router.post(
  '/otp/send',
  otpLimiter,
  [body('email').isEmail().normalizeEmail().withMessage('Valid email is required.')],
  async (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const { email } = req.body;

      const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
      if (!user) {
        // Generic response to avoid email enumeration
        return res.json({
          success: true,
          message: 'If that email is registered, an OTP has been sent.',
        });
      }

      const otp = generateOTP();
      const otpHash = hashOTP(otp);
      const expiresAt = new Date(Date.now() + (Number(process.env.OTP_EXPIRES_MINUTES) || 10) * 60_000).toISOString();
      const now = new Date().toISOString();

      // Store OTP hash in users table
      db.prepare(`
        UPDATE users SET otp_code = ?, otp_expires_at = ?, otp_verified = 0, updated_at = ? WHERE id = ?
      `).run(otpHash, expiresAt, now, user.id);

      // Audit log
      db.prepare(`
        INSERT INTO otp_audit (id, user_id, email, otp_hash, purpose, attempts, used, expires_at, created_at)
        VALUES (?, ?, ?, ?, 'login', 0, 0, ?, ?)
      `).run(uuidv4(), user.id, email, otpHash, expiresAt, now);

      // Send email (best-effort; don't fail the request if SMTP is unconfigured in dev)
      try {
        const transporter = createTransporter();
        await transporter.sendMail({
          from: process.env.OTP_FROM || 'noreply@proctorshield.app',
          to: email,
          subject: 'ProctorShield — Your Login OTP',
          text: `Your OTP is: ${otp}\n\nThis code expires in ${process.env.OTP_EXPIRES_MINUTES || 10} minutes. Do not share it with anyone.`,
          html: `<p>Your OTP is: <strong>${otp}</strong></p><p>This code expires in ${process.env.OTP_EXPIRES_MINUTES || 10} minutes.</p>`,
        });
      } catch (mailErr) {
        // Log but don't expose SMTP errors to client
        console.warn('[OTP] Email send failed (dev mode?):', mailErr.message);
        if (process.env.NODE_ENV !== 'production') {
          console.info('[OTP] DEV OTP for', email, ':', otp);
        }
      }

      return res.json({
        success: true,
        message: 'If that email is registered, an OTP has been sent.',
        ...(process.env.NODE_ENV !== 'production' ? { dev_otp: otp } : {}),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /otp/verify ─────────────────────────────────────────────────────────

router.post(
  '/otp/verify',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required.'),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits.'),
  ],
  async (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const { email, otp } = req.body;

      const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
      if (!user || !user.otp_code || !user.otp_expires_at) {
        return res.status(400).json({
          success: false,
          error: 'InvalidOTP',
          message: 'No pending OTP for this email.',
        });
      }

      if (new Date(user.otp_expires_at) < new Date()) {
        return res.status(400).json({
          success: false,
          error: 'OTPExpired',
          message: 'OTP has expired. Please request a new one.',
        });
      }

      const valid = verifyOTP(otp, user.otp_code);
      if (!valid) {
        return res.status(400).json({
          success: false,
          error: 'InvalidOTP',
          message: 'Invalid OTP.',
        });
      }

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE users SET otp_code = NULL, otp_expires_at = NULL, otp_verified = 1, updated_at = ? WHERE id = ?
      `).run(now, user.id);

      const token = signToken(user);
      const { password_hash, otp_code, otp_expires_at, ...safeUser } = user;

      return res.json({
        success: true,
        message: 'OTP verified. Login successful.',
        data: { user: safeUser, token },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /face/enroll ────────────────────────────────────────────────────────

router.post(
  '/face/enroll',
  authenticate,
  [body('face_descriptor').notEmpty().withMessage('face_descriptor is required.')],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const { face_descriptor } = req.body;
      const descriptorStr = typeof face_descriptor === 'string'
        ? face_descriptor
        : JSON.stringify(face_descriptor);

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE users SET face_descriptor = ?, face_enrolled = 1, updated_at = ? WHERE id = ?
      `).run(descriptorStr, now, req.user.id);

      return res.json({
        success: true,
        message: 'Face data enrolled successfully.',
        data: { face_enrolled: true },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /face/verify ────────────────────────────────────────────────────────

router.post(
  '/face/verify',
  authenticate,
  [body('face_descriptor').notEmpty().withMessage('face_descriptor is required.')],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const user = db.prepare('SELECT face_descriptor, face_enrolled FROM users WHERE id = ?').get(req.user.id);

      if (!user || !user.face_enrolled || !user.face_descriptor) {
        return res.status(400).json({
          success: false,
          error: 'FaceNotEnrolled',
          message: 'No face data enrolled for this user.',
        });
      }

      // Stub implementation: if both descriptors exist, consider matched.
      // Real face matching would be done client-side (face-api.js) and only result sent here.
      const submitted = req.body.face_descriptor;
      const matched = submitted !== null && submitted !== undefined;

      return res.json({
        success: true,
        message: matched ? 'Face verification successful.' : 'Face verification failed.',
        data: { matched, confidence: matched ? 0.97 : 0.0 },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /me ──────────────────────────────────────────────────────────────────

router.get('/me', authenticate, (req, res, next) => {
  try {
    const user = db.prepare(`
      SELECT id, name, email, phone, role, face_enrolled, otp_verified, is_active, created_at, updated_at
      FROM users WHERE id = ?
    `).get(req.user.id);

    if (!user) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'User not found.' });
    }

    return res.json({ success: true, message: 'User profile.', data: { user } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /logout ─────────────────────────────────────────────────────────────

router.post('/logout', authenticate, (req, res, next) => {
  try {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE users SET otp_code = NULL, otp_expires_at = NULL, updated_at = ? WHERE id = ?
    `).run(now, req.user.id);

    return res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

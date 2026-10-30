'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/**
 * Generate a cryptographically random 6-digit OTP string.
 */
function generateOTP() {
  // Use crypto to get an unbiased random 6-digit number
  const num = crypto.randomInt(0, 1000000);
  return String(num).padStart(6, '0');
}

/**
 * Hash an OTP using bcrypt (rounds=8 for speed).
 * @param {string} otp
 * @returns {string} bcrypt hash
 */
function hashOTP(otp) {
  return bcrypt.hashSync(otp, 8);
}

/**
 * Verify a plaintext OTP against a bcrypt hash.
 * @param {string} otp
 * @param {string} hash
 * @returns {boolean}
 */
function verifyOTP(otp, hash) {
  return bcrypt.compareSync(otp, hash);
}

module.exports = { generateOTP, hashOTP, verifyOTP };

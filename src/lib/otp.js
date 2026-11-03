const crypto = require('crypto');
const prisma = require('../config/database');

/**
 * Helpers for short numeric one-time codes (email verification, portal
 * access). Codes are 6 digits from a CSPRNG, stored only as a salted hash,
 * and guessing is limited by counting failed attempts as OtpCode rows of a
 * separate purpose — no schema change, and the count is shared across
 * server instances (an in-memory limiter is not).
 */

function generateNumericCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp(userId, code) {
  return crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

async function recentFailures(userId, failedPurpose, windowMs) {
  return prisma.otpCode.count({
    where: { userId, purpose: failedPurpose, createdAt: { gte: new Date(Date.now() - windowMs) } },
  });
}

async function recordFailure(userId, failedPurpose, windowMs) {
  await prisma.otpCode.create({
    data: { userId, code: 'x', purpose: failedPurpose, expiresAt: new Date(Date.now() + windowMs) },
  });
}

async function clearFailures(userId, failedPurpose) {
  await prisma.otpCode.updateMany({
    where: { userId, purpose: failedPurpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

module.exports = { generateNumericCode, hashOtp, recentFailures, recordFailure, clearFailures };

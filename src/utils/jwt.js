const jwt = require('jsonwebtoken');
const crypto = require('crypto');

function signAccessToken({ userId, businessId }) {
  return jwt.sign({ sub: userId, businessId: businessId || null }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m',
  });
}

function signRefreshToken() {
  // Opaque random token stored (hashed) on the Session row — not a JWT, so it
  // can be revoked server-side without waiting for expiry.
  return crypto.randomBytes(48).toString('hex');
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken };

const crypto = require('crypto');

/** SHA-256 hex digest. Used to store opaque bearer tokens (refresh, reset, invite) so a database read does not yield usable credentials. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** 256-bit URL-safe random token. */
function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashToken, randomToken };

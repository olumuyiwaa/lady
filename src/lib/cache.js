const Redis = require('ioredis');

let client;
function getClient() {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  client = new Redis(url);
  return client;
}

async function get(key) {
  const c = getClient();
  if (!c) return null;
  const v = await c.get(key);
  return v ? JSON.parse(v) : null;
}

async function set(key, value, ttlSeconds = 60) {
  const c = getClient();
  if (!c) return false;
  await c.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  return true;
}

module.exports = { get, set, getClient };

/**
 * Which browser origins may call the API (REST) and connect to the socket.
 *
 * Sources, all read at call time so tests and config changes need no restart
 * of module state:
 *   FRONTEND_URL        one origin or a comma-separated list (staging/preview)
 *   WIDGET_BASE_DOMAIN  every https subdomain of it (and the bare domain) may
 *                       call the public widget endpoints; REST only
 *   development         http://localhost:3000 and :3001 when NODE_ENV is not
 *                       production
 *
 * Entries are normalised (trimmed, lowercased, trailing slashes removed), so
 * `https://app.example.nl/` in FRONTEND_URL matches the browser's Origin
 * header `https://app.example.nl`. A path or query in the value is dropped.
 */

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    // Not a URL (e.g. "app.example.nl"): keep it as written so it simply never
    // matches, rather than throwing at request time.
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

function frontendOrigins(env = process.env) {
  const origins = new Set();
  String(env.FRONTEND_URL || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean)
    .forEach((o) => origins.add(o));
  if (env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://localhost:3001');
  }
  return origins;
}

function matchesWidgetDomain(origin, env) {
  const base = String(env.WIDGET_BASE_DOMAIN || '').trim().toLowerCase().replace(/^\*?\./, '');
  if (!base) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Plain http only for local development.
  if (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:')) return false;
  return url.hostname === base || url.hostname.endsWith(`.${base}`);
}

/**
 * @param {string|undefined} origin value of the request's Origin header
 * @param {{ widget?: boolean, env?: object }} [opts] widget=false limits the
 *   check to FRONTEND_URL (used by the socket server)
 */
function isOriginAllowed(origin, { widget = true, env = process.env } = {}) {
  // No Origin header: not a browser cross-origin request (curl, server to
  // server, same-origin GET). CORS does not apply to it.
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (frontendOrigins(env).has(normalized)) return true;
  return widget ? matchesWidgetDomain(origin, env) : false;
}

/**
 * Options for the `cors` middleware (and socket.io's `cors` option). A
 * disallowed origin is answered WITHOUT CORS headers, so the browser blocks the
 * response, instead of raising an error that surfaces as a 500 and a stack trace
 * in the logs for every blocked request.
 */
function corsOptions({ widget = true, credentials = false } = {}) {
  return {
    origin(origin, callback) {
      callback(null, isOriginAllowed(origin, { widget }));
    },
    credentials,
  };
}

module.exports = { isOriginAllowed, corsOptions, frontendOrigins, normalizeOrigin };

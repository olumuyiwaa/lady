const service = require('./calendarFeed.service');
const { success } = require('../../utils/response');

// Where calendar apps should fetch the feed from. Prefer an explicit public API
// URL; otherwise derive it from this request (trust proxy is enabled).
const baseUrlOf = (req) => process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

async function create(req, res, next) {
  try {
    const feed = await service.createFeed({
      businessId: req.businessId,
      actor: req.user,
      cleanerId: req.body?.cleanerId,
      label: req.body?.label,
      baseUrl: baseUrlOf(req),
    });
    return success(res, 201, feed, 'Copy this link now: it is shown only once.');
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    return success(res, 200, { feeds: await service.listFeeds({ businessId: req.businessId, actor: req.user }) });
  } catch (err) {
    next(err);
  }
}

async function revoke(req, res, next) {
  try {
    await service.revokeFeed({ businessId: req.businessId, actor: req.user, id: req.params.id });
    return success(res, 200, null, 'Calendar link revoked');
  } catch (err) {
    next(err);
  }
}

/** Public: the token in the URL is the credential. */
async function serve(req, res, next) {
  try {
    const token = String(req.params.file || '').replace(/\.ics$/i, '');
    const body = await service.renderForToken(token);
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="ladygreener.ics"',
      // The URL is a secret: keep it out of shared caches and referrers.
      'Cache-Control': 'private, max-age=300',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    });
    return res.status(200).send(body);
  } catch (err) {
    if (err.status === 404) return res.status(404).type('text/plain').send('Not found');
    next(err);
  }
}

module.exports = { create, list, revoke, serve };

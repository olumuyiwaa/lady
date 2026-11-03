const { resolveBusiness } = require('./resolveSingleBusiness');

// The :subdomain param is ignored: there is only one business.
module.exports = { resolveBusinessFromSlug: resolveBusiness };

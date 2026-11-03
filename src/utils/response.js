function success(res, status, data, message = null) {
  return res.status(status).json({ success: true, message, data });
}

function error(res, status, message, errors = null) {
  return res.status(status).json({ success: false, message, errors });
}

module.exports = { success, error };

const express = require('express');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const { success } = require('../../utils/response');
const service = require('./invoices.service');
const prisma = require('../../config/database');

const router = express.Router();

// Invoices carry the customer's address and the business's tax identity:
// owners and managers only (cleaners must never see them).
router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

router.get('/', async (req, res, next) => {
  try {
    return success(res, 200, await service.listInvoices(req.businessId, req.query));
  } catch (err) { next(err); }
});

// Issue (idempotent) the invoice for a booking.
router.post('/booking/:bookingId', async (req, res, next) => {
  try {
    const inv = await service.issueForBooking(req.businessId, req.params.bookingId, req.user.id);
    return success(res, 201, inv);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    return success(res, 200, await service.getInvoice(req.businessId, req.params.id));
  } catch (err) { next(err); }
});

// Printable HTML. Fetch it with the Authorization header and open the result
// (a plain link cannot send the bearer token).
router.get('/:id/html', async (req, res, next) => {
  try {
    const inv = await service.getInvoice(req.businessId, req.params.id);
    const biz = await prisma.business.findUnique({ where: { id: req.businessId }, select: { timezone: true } });
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      // Inert document: inline styles only, no scripts, no framing.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return res.send(service.renderInvoiceHtml(inv, biz && biz.timezone));
  } catch (err) { next(err); }
});

// UBL 2.1 XML for a single invoice — for importing into the business's own
// accounting software (Exact Online, Moneybird, e-Boekhouden, SnelStart all
// accept a UBL file import). See lib/ubl.js for what this format does and
// doesn't cover.
router.get('/:id/ubl', async (req, res, next) => {
  try {
    const inv = await service.getInvoice(req.businessId, req.params.id);
    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${inv.number}.xml"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return res.send(service.generateUBLInvoiceXML(inv));
  } catch (err) { next(err); }
});

// Every invoice in a date range as one .zip of UBL files — the shape an
// accountant actually wants at period-end, rather than clicking through
// invoices one at a time. Reuses listInvoices' own date filtering/limits.
router.get('/export/ubl.zip', async (req, res, next) => {
  try {
    const invoices = await service.listInvoices(req.businessId, { ...req.query, limit: req.query.limit || 500 });
    if (!invoices.length) {
      return res.status(404).json({ success: false, message: 'No invoices found for that range' });
    }
    const archiver = require('archiver');
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="invoices-${req.query.from || 'all'}-${req.query.to || 'now'}.zip"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => next(err));
    archive.pipe(res);
    for (const inv of invoices) {
      archive.append(service.generateUBLInvoiceXML(inv), { name: `${inv.number}.xml` });
    }
    await archive.finalize();
  } catch (err) { next(err); }
});

module.exports = router;

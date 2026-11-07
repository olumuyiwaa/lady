/**
 * Business accounts, manager side (owner / manager only).
 *   GET    /b2b-accounts?month=YYYY-MM                         companies with the month's quality figures
 *   GET    /b2b-accounts/:customerId/quality?month=            per-branch report (JSON)
 *   GET    /b2b-accounts/:customerId/quality.pdf?month=        the same as a PDF
 *   GET    /b2b-accounts/:customerId/locations                 branches that can be assigned
 *   GET    /b2b-accounts/:customerId/members                   team members
 *   POST   /b2b-accounts/:customerId/members                   add one
 *   PUT    /b2b-accounts/:customerId/members/:memberId         change role / branches / details
 *   DELETE /b2b-accounts/:customerId/members/:memberId         switch access off
 */
const express = require('express');
const { body } = require('express-validator');
const service = require('./b2bAccounts.service');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');
const { success } = require('../../utils/response');

const router = express.Router();
router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

const wrap = (fn, status = 200) => async (req, res, next) => {
  try {
    return success(res, status, await fn(req));
  } catch (err) {
    next(err);
  }
};

const memberBody = [
  body('firstName').optional().isString(),
  body('lastName').optional().isString(),
  body('email').optional({ values: 'falsy' }).isEmail(),
  body('phone').optional({ values: 'falsy' }).isString(),
  body('role').optional().isIn(['ADMIN', 'BRANCH_MANAGER']),
  body('locationKeys').optional().isArray({ max: 200 }),
  body('isActive').optional().isBoolean({ strict: true }),
];

router.get('/', wrap((req) => service.list(req.businessId, req.query.month)));
router.get('/:customerId/quality', wrap((req) => service.quality(req.businessId, req.params.customerId, req.query.month)));
router.get('/:customerId/quality.pdf', async (req, res, next) => {
  try {
    const pdf = await service.qualityPdf(req.businessId, req.params.customerId, req.query.month);
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : 'report';
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="quality-${month}.pdf"`, 'Cache-Control': 'private, no-store' });
    return res.send(pdf);
  } catch (err) {
    next(err);
  }
});
router.get('/:customerId/locations', wrap((req) => service.listLocations(req.businessId, req.params.customerId)));
router.get('/:customerId/members', wrap((req) => service.listMembers(req.businessId, req.params.customerId)));
router.post('/:customerId/members', memberBody, validate, wrap((req) => service.createMember(req.businessId, req.params.customerId, req.body), 201));
router.put('/:customerId/members/:memberId', memberBody, validate, wrap((req) => service.updateMember(req.businessId, req.params.customerId, req.params.memberId, req.body)));
router.delete('/:customerId/members/:memberId', wrap((req) => service.removeMember(req.businessId, req.params.customerId, req.params.memberId)));

module.exports = router;

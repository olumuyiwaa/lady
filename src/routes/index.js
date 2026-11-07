const express = require('express');

const router = express.Router();

// Auth + tenant onboarding
router.use('/auth', require('../modules/auth/auth.routes'));

// Business dashboard (authenticated, tenant-scoped)
router.use('/businesses', require('../modules/businesses/businesses.routes'));
router.use('/businesses/pricing', require('../modules/pricing/pricing.routes'));
// Team/staff (BusinessMember) invite + role + removal — kept separate from
// /businesses since it's a distinct owner-only resource, same reasoning as
// /businesses/pricing living apart from the general businesses.routes.
router.use('/businesses/staff', require('../modules/staff/staff.routes'));
// Cleaner self-service (own profile/availability/documents) — registered
// before the admin /cleaners router so /cleaners/me/* is handled here first;
// Express falls through to the admin router for everything else under /cleaners.
router.use('/cleaners', require('../modules/cleanerSelf/cleanerSelf.routes'));
router.use('/cleaners', require('../modules/cleaners/cleaners.routes'));
router.use('/customers', require('../modules/customers/customers.routes'));
router.use('/services', require('../modules/services/services.routes'));
// Cleaner self-service — own assigned jobs only (must be before /bookings/:id admin routes if paths overlap)
router.use('/cleaner/bookings', require('../modules/bookings/cleanerBookings.routes'));
// Admin bookings
router.use('/bookings', require('../modules/bookings/bookings.routes'));
router.use('/referrals', require('../modules/referrals/referrals.routes'));
router.use('/dispatch', require('../modules/dispatch/dispatch.routes'));
router.use('/checklists', require('../modules/checklists/checklists.routes'));
router.use('/checklist-templates', require('../modules/checklistTemplates/checklistTemplates.routes'));
router.use('/messaging', require('../modules/messaging/messaging.routes'));
router.use('/notifications', require('../modules/notifications/notifications.routes'));
router.use('/reviews', require('../modules/reviews/reviews.routes'));
router.use('/reports', require('../modules/reports/reports.routes'));
router.use('/transactions', require('../modules/transactions/transactions.routes'));
router.use('/storage', require('../modules/storage/storage.routes'));
router.use('/support-tickets', require('../modules/supportTickets/supportTickets.routes'));
router.use('/cleaner-documents', require('../modules/cleanerDocuments/cleanerDocuments.routes'));

// Public booking widget (unauthenticated, resolved from Host header)
const widgetRoutes = require('../modules/widget/widget.routes');
router.use('/widget', widgetRoutes);

// Public booking widget, slug-resolved — no custom-domain/DNS setup
// required. Same endpoints, mounted per-business at /widget-embed/:subdomain.
router.use('/widget-embed/:subdomain', widgetRoutes.slugRouter);
router.use('/portal', require('../modules/customerPortal/customerPortal.routes'));
router.use('/calendar', require('../modules/calendar/calendar.routes'));
router.use('/booking-questions', require('../modules/bookingQuestions/bookingQuestions.routes'));
// Public, token-authenticated iCalendar feed (see calendarFeed.service.js)
router.use('/calendar-feed', require('../modules/calendar/calendarFeed.public.routes'));
router.use('/inventory', require('../modules/inventory/inventory.routes'));
router.use('/compliance', require('../modules/compliance/compliance.routes'));
router.use('/payroll', require('../modules/payroll/payroll.routes'));
router.use('/leave', require('../modules/leave/leave.routes'));
router.use('/waitlist', require('../modules/waitlist/waitlist.routes'));
router.use('/invoices', require('../modules/invoices/invoices.routes'));

const portalRoutes = require('../modules/customerPortal/customerPortal.routes');
router.use('/portal', portalRoutes);
router.use('/portal-embed/:subdomain', portalRoutes.slugRouter);

module.exports = router;
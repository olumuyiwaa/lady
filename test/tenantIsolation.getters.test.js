// Regression coverage for the "business A cannot read/touch business B's
// data" invariant across the modules audited for this pass. Each of these
// was already scoping its Prisma call by businessId correctly (unlike the
// reviews/payroll bugs fixed alongside this file — see
// reviews.service.crossTenant.test.js and payroll.service.crossTenant.test.js)
// — this file exists to keep it that way. It fails loudly if a future edit
// drops the businessId filter or stops surfacing a 403/404 for a
// cross-tenant id, rather than silently returning another business's row.

jest.mock('../src/config/database.js', () => ({
  customer: { findFirst: jest.fn() },
  invoice: { findFirst: jest.fn() },
  service: { findFirst: jest.fn() },
  waitlistEntry: { findFirst: jest.fn(), update: jest.fn() },
  businessMember: { findFirst: jest.fn(), update: jest.fn() },
  session: { deleteMany: jest.fn() },
  cleanerDocument: { findFirst: jest.fn() },
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({}));

const prisma = require('../src/config/database.js');
const customers = require('../src/modules/customers/customers.service');
const invoices = require('../src/modules/invoices/invoices.service');
const services = require('../src/modules/services/services.service');
const waitlist = require('../src/modules/waitlist/waitlist.service');
const staff = require('../src/modules/staff/staff.service');
const cleanerDocuments = require('../src/modules/cleanerDocuments/cleanerDocuments.service');

const OWN_BUSINESS = 'biz-A';
const CROSS_TENANT_ID = 'id-actually-owned-by-biz-B';

beforeEach(() => {
  jest.clearAllMocks();
});

// Table-driven: [label, fn, expectedStatus]. Every fn below simulates the
// real-world "id exists, but for a different business" case by mocking the
// findFirst call to return null — which is exactly what a businessId-scoped
// WHERE clause produces against a real database for a cross-tenant id.
describe('cross-tenant id is rejected, not silently served', () => {
  test.each([
    [
      'customers.getCustomer',
      404,
      () => {
        prisma.customer.findFirst.mockResolvedValue(null);
        return customers.getCustomer(OWN_BUSINESS, CROSS_TENANT_ID);
      },
    ],
    [
      'invoices.getInvoice',
      404,
      () => {
        prisma.invoice.findFirst.mockResolvedValue(null);
        return invoices.getInvoice(OWN_BUSINESS, CROSS_TENANT_ID);
      },
    ],
    [
      'services.getService',
      404,
      () => {
        prisma.service.findFirst.mockResolvedValue(null);
        return services.getService(OWN_BUSINESS, CROSS_TENANT_ID);
      },
    ],
    [
      'waitlist.cancelWaitlistEntry',
      404,
      () => {
        prisma.waitlistEntry.findFirst.mockResolvedValue(null);
        return waitlist.cancelWaitlistEntry(OWN_BUSINESS, CROSS_TENANT_ID);
      },
    ],
    [
      'staff.updateMemberRole',
      404,
      () => {
        prisma.businessMember.findFirst.mockResolvedValue(null);
        return staff.updateMemberRole(OWN_BUSINESS, 'actor1', CROSS_TENANT_ID, 'BUSINESS_MANAGER');
      },
    ],
    [
      'staff.removeMember',
      404,
      () => {
        prisma.businessMember.findFirst.mockResolvedValue(null);
        return staff.removeMember(OWN_BUSINESS, 'actor1', CROSS_TENANT_ID);
      },
    ],
    [
      'cleanerDocuments.getDocument',
      404,
      () => {
        prisma.cleanerDocument.findFirst.mockResolvedValue(null);
        return cleanerDocuments.getDocument(OWN_BUSINESS, CROSS_TENANT_ID);
      },
    ],
  ])('%s rejects with %i for a cross-tenant id', async (_label, expectedStatus, run) => {
    await expect(run()).rejects.toMatchObject({ status: expectedStatus });
  });
});

describe('the underlying query is actually scoped by businessId (not just id)', () => {
  test('customers.getCustomer', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: CROSS_TENANT_ID, businessId: OWN_BUSINESS, referralCode: 'X' });
    await customers.getCustomer(OWN_BUSINESS, CROSS_TENANT_ID);
    const where = prisma.customer.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: CROSS_TENANT_ID, businessId: OWN_BUSINESS });
  });

  test('invoices.getInvoice', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: CROSS_TENANT_ID });
    await invoices.getInvoice(OWN_BUSINESS, CROSS_TENANT_ID);
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith({ where: { id: CROSS_TENANT_ID, businessId: OWN_BUSINESS } });
  });

  test('services.getService', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: CROSS_TENANT_ID });
    await services.getService(OWN_BUSINESS, CROSS_TENANT_ID);
    expect(prisma.service.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CROSS_TENANT_ID, businessId: OWN_BUSINESS } })
    );
  });

  test('waitlist.cancelWaitlistEntry', async () => {
    prisma.waitlistEntry.findFirst.mockResolvedValue({ id: CROSS_TENANT_ID });
    prisma.waitlistEntry.update.mockResolvedValue({});
    await waitlist.cancelWaitlistEntry(OWN_BUSINESS, CROSS_TENANT_ID);
    expect(prisma.waitlistEntry.findFirst).toHaveBeenCalledWith({ where: { id: CROSS_TENANT_ID, businessId: OWN_BUSINESS } });
  });

  test('staff.updateMemberRole / removeMember', async () => {
    prisma.businessMember.findFirst.mockResolvedValue({ id: CROSS_TENANT_ID, role: 'BUSINESS_MANAGER', userId: 'someone-else' });
    prisma.businessMember.update.mockResolvedValue({});
    await staff.updateMemberRole(OWN_BUSINESS, 'actor1', CROSS_TENANT_ID, 'ORG_ADMIN');
    expect(prisma.businessMember.findFirst).toHaveBeenCalledWith({ where: { id: CROSS_TENANT_ID, businessId: OWN_BUSINESS } });

    jest.clearAllMocks();
    prisma.businessMember.findFirst.mockResolvedValue({ id: CROSS_TENANT_ID, role: 'BUSINESS_MANAGER', userId: 'someone-else' });
    await staff.removeMember(OWN_BUSINESS, 'actor1', CROSS_TENANT_ID);
    expect(prisma.businessMember.findFirst).toHaveBeenCalledWith({ where: { id: CROSS_TENANT_ID, businessId: OWN_BUSINESS } });
  });

  test('cleanerDocuments.getDocument', async () => {
    prisma.cleanerDocument.findFirst.mockResolvedValue({ id: CROSS_TENANT_ID });
    await cleanerDocuments.getDocument(OWN_BUSINESS, CROSS_TENANT_ID);
    expect(prisma.cleanerDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CROSS_TENANT_ID, businessId: OWN_BUSINESS } })
    );
  });
});

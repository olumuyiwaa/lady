jest.mock('../src/config/database.js', () => ({
  business: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  service: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
}));
jest.mock('../src/config/storage', () => ({ getPublicUploadUrl: jest.fn(), getPublicUrl: jest.fn() }));
jest.mock('../src/lib/subscriptionAccess', () => ({ getEffectivePlan: jest.fn().mockResolvedValue(null), getAccess: jest.fn() }));

const prisma = require('../src/config/database.js');
const businesses = require('../src/modules/businesses/businesses.service');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.business.findUnique.mockResolvedValue({ id: 'b1', currency: 'eur', timezone: 'Europe/Amsterdam' });
  prisma.business.update.mockImplementation(async ({ data }) => ({ id: 'b1', ...data }));
});

describe('business tax settings', () => {
  test('valid identifiers are normalised and stored', async () => {
    await businesses.updateBusiness('b1', {
      legalName: '  Schoon Holding B.V. ', kvkNumber: '1234 5678', vatNumber: 'nl 1234.56.789 b01',
      invoiceIban: 'NL91 ABNA 0417 1643 00', vatRateBps: '900',
    });
    expect(prisma.business.update.mock.calls[0][0].data).toMatchObject({
      legalName: 'Schoon Holding B.V.', kvkNumber: '12345678', vatNumber: 'NL123456789B01',
      invoiceIban: 'NL91ABNA0417164300', vatRateBps: 900,
    });
  });

  test.each([
    [{ kvkNumber: '123' }, /KvK/],
    [{ vatNumber: 'NL123' }, /BTW-id/],
    [{ invoiceIban: 'NL91 ABNA 0417 1643 01' }, /IBAN/],
    [{ vatRateBps: 2100.5 }, /basis points/],
    [{ vatRateBps: 5000 }, /basis points/],
    [{ vatRateBps: -1 }, /basis points/],
  ])('rejects %j', async (patch, msg) => {
    await expect(businesses.updateBusiness('b1', patch)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(msg) });
    expect(prisma.business.update).not.toHaveBeenCalled();
  });

  test('blank values clear the field', async () => {
    await businesses.updateBusiness('b1', { kvkNumber: '', vatNumber: null, invoiceIban: '  ' });
    expect(prisma.business.update.mock.calls[0][0].data).toMatchObject({ kvkNumber: null, vatNumber: null, invoiceIban: null });
  });
});

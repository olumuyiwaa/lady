jest.mock('../src/config/database.js', () => ({}));
const { upsertGuestCustomer } = require('../src/modules/widget/widget.service');

const attacker = { firstName: 'Eve', lastName: 'Attacker', email: 'eve@evil.test', phone: '+31611111111' };

describe('widget.service.upsertGuestCustomer', () => {
  test('never rewrites contact details of an existing customer', async () => {
    const client = {
      customer: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'c1' }),
      },
    };
    await upsertGuestCustomer(client, 'biz1', attacker);
    const arg = client.customer.upsert.mock.calls[0][0];
    expect(arg.update).toEqual({});
    expect(arg.create).toMatchObject({ businessId: 'biz1', email: 'eve@evil.test', phone: '+31611111111' });
  });

  test('an existing customer stored in another phone format is returned untouched, not duplicated', async () => {
    const existing = { id: 'c1', phone: '0611111111', email: 'victim@real.test' };
    const client = {
      customer: { findFirst: jest.fn().mockResolvedValue(existing), upsert: jest.fn(), update: jest.fn() },
    };
    const out = await upsertGuestCustomer(client, 'biz1', attacker);
    expect(out).toBe(existing);
    expect(client.customer.upsert).not.toHaveBeenCalled();
    expect(client.customer.update).not.toHaveBeenCalled();
    // looked up across formats, scoped to the business
    const where = client.customer.findFirst.mock.calls[0][0].where;
    expect(where.businessId).toBe('biz1');
    expect(where.phone.in).toEqual(expect.arrayContaining(['+31611111111', '0611111111']));
  });

  test('a new customer is stored with the normalised phone number', async () => {
    const client = {
      customer: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'c2' }),
      },
    };
    await upsertGuestCustomer(client, 'biz1', { ...attacker, phone: '06 11111111' });
    const arg = client.customer.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ businessId_phone: { businessId: 'biz1', phone: '+31611111111' } });
    expect(arg.create.phone).toBe('+31611111111');
  });
});

const { normalizePhone, phoneLookupVariants, findCustomerByPhone } = require('../src/lib/phone');

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe('normalizePhone (default country NL)', () => {
  test.each([
    ['06 12345678', '+31612345678'],
    ['0612345678', '+31612345678'],
    ['06-12345678', '+31612345678'],
    ['+31 6 12345678', '+31612345678'],
    ['+31 (0)6 12345678', '+31612345678'],
    ['0031612345678', '+31612345678'],
    ['31612345678', '+31612345678'],
    ['612345678', '+31612345678'],
    ['+49 151 12345678', '+4915112345678'],
    ['4915112345678', '+4915112345678'],
    ['+1 (555) 000-0000', '+15550000000'],
    ['  +31612345678  ', '+31612345678'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  test('is idempotent', () => {
    const once = normalizePhone('06 12345678');
    expect(normalizePhone(once)).toBe(once);
  });

  test('leaves values that are not phone numbers untouched', () => {
    // customers.service anonymisation writes this into the unique phone column.
    expect(normalizePhone('deleted-ckx123abc456')).toBe('deleted-ckx123abc456');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone('123')).toBe('123'); // too short to be a real number
    expect(normalizePhone(undefined)).toBeUndefined();
  });

  test('uses DEFAULT_PHONE_COUNTRY_CODE for nationally written numbers', () => {
    process.env.DEFAULT_PHONE_COUNTRY_CODE = '+44';
    expect(normalizePhone('07911 123456')).toBe('+447911123456');
  });
});

describe('phoneLookupVariants', () => {
  test('covers every common stored form of the same number', () => {
    const v = phoneLookupVariants('06 12345678');
    expect(v).toEqual(
      expect.arrayContaining(['06 12345678', '+31612345678', '31612345678', '0031612345678', '0612345678'])
    );
  });
  test('is empty for blank input', () => {
    expect(phoneLookupVariants('   ')).toEqual([]);
    expect(phoneLookupVariants(null)).toEqual([]);
  });
});

describe('findCustomerByPhone', () => {
  test('queries every variant, oldest customer first, scoped to the business', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'c1' });
    const out = await findCustomerByPhone({ customer: { findFirst } }, 'biz1', '+31 6 12345678');
    expect(out).toEqual({ id: 'c1' });
    const arg = findFirst.mock.calls[0][0];
    expect(arg.where.businessId).toBe('biz1');
    expect(arg.where.phone.in).toEqual(expect.arrayContaining(['+31612345678', '0612345678']));
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
  });
  test('does not query for a blank phone', async () => {
    const findFirst = jest.fn();
    expect(await findCustomerByPhone({ customer: { findFirst } }, 'biz1', ' ')).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

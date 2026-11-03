jest.mock('../src/config/database.js', () => ({
  bookingQuestion: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  service: { count: jest.fn() },
}));
const prisma = require('../src/config/database.js');
const svc = require('../src/modules/bookingQuestions/bookingQuestions.service');

const q = (over = {}) => ({ id: 'q1', label: 'Question', type: 'TEXT', options: [], required: false, serviceIds: [], sortOrder: 0, isActive: true, ...over });
const ask = (questions, answers, serviceId = 's1') => svc.resolveAnswers(questions, serviceId, answers);

describe('resolveAnswers: which questions apply', () => {
  test('nothing asked and nothing answered gives an empty snapshot', () => {
    expect(ask([], undefined)).toEqual([]);
    expect(ask([q()], [])).toEqual([]);
  });
  test('inactive questions are not asked', () => {
    expect(ask([q({ isActive: false, required: true })], [])).toEqual([]);
  });
  test('a question limited to other services is not asked, and answering it is rejected', () => {
    const only2 = q({ serviceIds: ['s2'], required: true });
    expect(ask([only2], [], 's1')).toEqual([]);
    expect(() => ask([only2], [{ questionId: 'q1', value: 'x' }], 's1')).toThrow(/not asked/);
    expect(ask([only2], [{ questionId: 'q1', value: 'x' }], 's2')).toHaveLength(1);
  });
  test("an answer to another business's question id is rejected", () => {
    expect(() => ask([q()], [{ questionId: 'foreign', value: 'x' }])).toThrow(/not asked/);
  });
  test('the snapshot follows the display order', () => {
    const out = ask([q({ id: 'b', sortOrder: 2 }), q({ id: 'a', sortOrder: 1 })], [{ questionId: 'b', value: '2' }, { questionId: 'a', value: '1' }]);
    expect(out.map((x) => x.questionId)).toEqual(['a', 'b']);
  });
});

describe('resolveAnswers: required', () => {
  const req = q({ required: true, label: 'Floor?' });
  test('missing, blank and empty-list answers fail a required question', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(() => ask([req], v === undefined ? [] : [{ questionId: 'q1', value: v }])).toThrow(/Please answer: Floor\?/);
    }
    const multi = q({ type: 'MULTI_SELECT', options: ['a', 'b'], required: true });
    expect(() => ask([multi], [{ questionId: 'q1', value: [] }])).toThrow(/Please answer/);
  });
  test('"No" is a real answer to a required yes/no question', () => {
    const yn = q({ type: 'YES_NO', required: true });
    expect(ask([yn], [{ questionId: 'q1', value: false }])[0].value).toBe(false);
  });
  test('zero is a real answer to a required number question', () => {
    const n = q({ type: 'NUMBER', required: true });
    expect(ask([n], [{ questionId: 'q1', value: 0 }])[0].value).toBe(0);
  });
  test('an optional question may be skipped', () => {
    expect(ask([q()], [])).toEqual([]);
  });
});

describe('resolveAnswers: value validation per type', () => {
  test('TEXT is trimmed and length-limited', () => {
    expect(ask([q()], [{ questionId: 'q1', value: '  hi  ' }])[0].value).toBe('hi');
    expect(() => ask([q()], [{ questionId: 'q1', value: 'x'.repeat(501) }])).toThrow(/too long/);
    expect(() => ask([q({ type: 'LONG_TEXT' })], [{ questionId: 'q1', value: 'x'.repeat(2001) }])).toThrow(/too long/);
    expect(ask([q({ type: 'LONG_TEXT' })], [{ questionId: 'q1', value: 'x'.repeat(2000) }])).toHaveLength(1);
  });
  test('text answers must be strings', () => {
    expect(() => ask([q()], [{ questionId: 'q1', value: 42 }])).toThrow(/Invalid answer/);
  });
  test('SELECT only accepts one of the configured options', () => {
    const s = q({ type: 'SELECT', options: ['Cat', 'Dog'] });
    expect(ask([s], [{ questionId: 'q1', value: 'Cat' }])[0].value).toBe('Cat');
    expect(() => ask([s], [{ questionId: 'q1', value: 'Hamster' }])).toThrow(/Invalid choice/);
    expect(() => ask([s], [{ questionId: 'q1', value: ['Cat'] }])).toThrow(/Invalid choice/);
  });
  test('MULTI_SELECT accepts a list of options, de-duplicated', () => {
    const m = q({ type: 'MULTI_SELECT', options: ['a', 'b', 'c'] });
    expect(ask([m], [{ questionId: 'q1', value: ['a', 'b', 'a'] }])[0].value).toEqual(['a', 'b']);
    expect(() => ask([m], [{ questionId: 'q1', value: ['a', 'z'] }])).toThrow(/Invalid choice/);
    expect(() => ask([m], [{ questionId: 'q1', value: 'a' }])).toThrow(/Invalid choice/);
  });
  test('YES_NO must be a real boolean, not a string', () => {
    const yn = q({ type: 'YES_NO' });
    expect(() => ask([yn], [{ questionId: 'q1', value: 'yes' }])).toThrow(/Invalid answer/);
  });
  test('NUMBER accepts numbers and numeric strings, rejects the rest', () => {
    const n = q({ type: 'NUMBER' });
    expect(ask([n], [{ questionId: 'q1', value: '3' }])[0].value).toBe(3);
    expect(ask([n], [{ questionId: 'q1', value: 2.5 }])[0].value).toBe(2.5);
    for (const bad of ['abc', Infinity, NaN, 1e12]) expect(() => ask([n], [{ questionId: 'q1', value: bad }])).toThrow(/Invalid number/);
  });
  test('malformed answer lists are rejected', () => {
    expect(() => ask([q()], 'nope')).toThrow(/must be a list/);
    expect(() => ask([q()], [null])).toThrow(/Invalid answer/);
    expect(() => ask([q()], Array.from({ length: 41 }, () => ({ questionId: 'q1', value: 'x' })))).toThrow(/Too many/);
  });
  test('the snapshot carries the question text and type', () => {
    expect(ask([q({ label: 'Pets?', type: 'YES_NO' })], [{ questionId: 'q1', value: true }])).toEqual([
      { questionId: 'q1', label: 'Pets?', type: 'YES_NO', value: true },
    ]);
  });
});

describe('managing questions', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.bookingQuestion.count.mockResolvedValue(0);
    prisma.bookingQuestion.create.mockImplementation(async ({ data }) => ({ id: 'new', ...data }));
    prisma.bookingQuestion.update.mockImplementation(async ({ data }) => ({ id: 'q1', ...data }));
  });

  test('creates a question for the business with sensible defaults', async () => {
    const out = await svc.create('biz', { label: ' Pets? ', type: 'YES_NO' });
    expect(prisma.bookingQuestion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ businessId: 'biz', label: 'Pets?', type: 'YES_NO', options: [], sortOrder: 0 }) });
    expect(out.id).toBe('new');
  });
  test('choice questions need 2 to 20 different options; other types ignore options', async () => {
    await expect(svc.create('biz', { label: 'x', type: 'SELECT', options: ['only'] })).rejects.toMatchObject({ status: 422 });
    await expect(svc.create('biz', { label: 'x', type: 'SELECT', options: ['a', 'a'] })).rejects.toMatchObject({ status: 422 });
    const ok = await svc.create('biz', { label: 'x', type: 'SELECT', options: ['a', ' b ', ''] });
    expect(ok.options).toEqual(['a', 'b']);
    const text = await svc.create('biz', { label: 'x', type: 'TEXT', options: ['leftover', 'junk'] });
    expect(text.options).toEqual([]);
  });
  test('rejects a blank or over-long label and an unknown type', async () => {
    await expect(svc.create('biz', { label: '  ', type: 'TEXT' })).rejects.toMatchObject({ status: 422 });
    await expect(svc.create('biz', { label: 'x'.repeat(201), type: 'TEXT' })).rejects.toMatchObject({ status: 422 });
    await expect(svc.create('biz', { label: 'x', type: 'PHOTO' })).rejects.toMatchObject({ status: 422 });
  });
  test('caps the number of questions per business', async () => {
    prisma.bookingQuestion.count.mockResolvedValue(svc.MAX_QUESTIONS_PER_BUSINESS);
    await expect(svc.create('biz', { label: 'x', type: 'TEXT' })).rejects.toMatchObject({ status: 422 });
  });
  test('services a question is limited to must belong to the same business', async () => {
    prisma.service.count.mockResolvedValue(1);
    await expect(svc.create('biz', { label: 'x', type: 'TEXT', serviceIds: ['s1', 'foreign'] })).rejects.toMatchObject({ status: 422 });
    expect(prisma.service.count).toHaveBeenCalledWith({ where: { id: { in: ['s1', 'foreign'] }, businessId: 'biz' } });
  });
  test("another business's question cannot be edited or deleted (looks like not found)", async () => {
    prisma.bookingQuestion.findFirst.mockResolvedValue(null);
    await expect(svc.update('biz', 'q1', { label: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.remove('biz', 'q1')).rejects.toMatchObject({ status: 404 });
    expect(prisma.bookingQuestion.findFirst).toHaveBeenCalledWith({ where: { id: 'q1', businessId: 'biz' } });
    expect(prisma.bookingQuestion.update).not.toHaveBeenCalled();
    expect(prisma.bookingQuestion.delete).not.toHaveBeenCalled();
  });
  test('a partial update changes only what was sent', async () => {
    prisma.bookingQuestion.findFirst.mockResolvedValue(q({ type: 'SELECT', options: ['a', 'b'] }));
    await svc.update('biz', 'q1', { required: true });
    expect(prisma.bookingQuestion.update).toHaveBeenCalledWith({ where: { id: 'q1' }, data: { required: true } });
  });
  test('switching a question away from a choice type clears its options', async () => {
    prisma.bookingQuestion.findFirst.mockResolvedValue(q({ type: 'SELECT', options: ['a', 'b'] }));
    await svc.update('biz', 'q1', { type: 'TEXT' });
    expect(prisma.bookingQuestion.update.mock.calls[0][0].data).toEqual({ type: 'TEXT', options: [] });
  });
  test('the public listing exposes only what the form needs', async () => {
    prisma.bookingQuestion.findMany.mockResolvedValue([{ ...q(), businessId: 'biz', createdAt: new Date(), updatedAt: new Date(), isActive: true }]);
    const [pub] = await svc.listPublic('biz');
    expect(Object.keys(pub).sort()).toEqual(['helpText', 'id', 'label', 'options', 'required', 'serviceIds', 'type']);
    expect(prisma.bookingQuestion.findMany.mock.calls[0][0].where).toEqual({ businessId: 'biz', isActive: true });
  });
});
